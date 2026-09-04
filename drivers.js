/*
 * drivers.js — per-scale connection drivers.
 *
 * A passive listener is not enough for most scales: they stay silent until the client subscribes
 * to the right characteristic, answers a handshake, and writes a user profile. Each driver below
 * encodes that conversation for one protocol family.
 *
 * PROVENANCE: the protocol facts (UUIDs, frame opcodes, field offsets, checksum rule, handshake
 * order) were researched from the openScale project (https://github.com/oliexdev/openScale,
 * GPL-3.0) and public documentation. No openScale source is copied — this is independently
 * written JavaScript. Credit for the reverse engineering belongs to olie.xdev and contributors.
 * openScale is GPL-3.0; if you want their actual code, relicense this project accordingly.
 *
 * Driver contract:
 *   id, label, matches(identity) -> boolean
 *   async init(ctx)                        set up subscriptions and send any handshake
 *   onFrame(uuid16, bytes, ctx) -> result  decode one notification; null if not ours
 *
 * ctx supplies: log, subscribe, write, profile, showResult, state, hex helpers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./bcs.js'), require('./bia.js'));
  } else {
    root.Drivers = factory(root.BCS, root.BIA);
  }
})(typeof self !== 'undefined' ? self : this, function (BCS, BIA) {
  'use strict';

  /* Returned by a driver for a frame it owns but that carries nothing new,
     so the caller suppresses it instead of falling through to the guesswork. */
  const SUPPRESS = { suppressed: true };

  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);

  /*
   * Frame alignment.
   *
   * Different firmware revisions in this family prepend a leading sequence-counter byte, so the
   * frame-type marker is not always at a fixed index. An SSW532 sends `xx 07 xx a2 …` while the
   * SSW533 observed on real hardware sends `90 00 07 00 a2 …`, where byte 0 counts up per frame.
   * Rather than hard-code an index, locate the marker and read every other field relative to it.
   */
  function findMarker(b, marker, confirm) {
    for (let i = 0; i <= 3 && i < b.length; i++) {
      if (b[i] !== marker) continue;
      if (typeof confirm === 'function' && !confirm(i)) continue;
      return i;
    }
    return -1;
  }
  const has = (b, i) => i >= 0 && i < b.length;

  function field(name, offset, size, value, unit, note) {
    return { name, offset, size, value, unit: unit || '', note: note || '', rawHex: '' };
  }

  // =========================================================================
  // Dr Trust SSW532 / SSW533 (and the wider 0xFFB0 "icomon" family)
  //
  // Wire protocol
  //   service 0xFFB0
  //     0xFFB1  write   command channel, always 20-byte packets, byte 19 = checksum
  //     0xFFB2  notify  live weight stream
  //     0xFFB3  notify  session setup + final body-composition frames
  //   checksum = (sum of bytes 3..18) mod 32
  //
  //   Handshake: subscribe 0xFFB3 -> scale sends a 0x18 setup frame with subtype 0x00 carrying a
  //   session id in byte 0 -> subscribe 0xFFB2 -> scale sends setup subtype 0x01 -> client writes
  //   three command packets (session ack, user profile, app name "icomon") -> scale starts
  //   measuring. Final data arrives as three 0x23 frames (weight, impedances, end-of-record).
  // =========================================================================
  const drTrust = {
    id: 'drtrust',
    label: 'Dr Trust SSW532 / SSW533 (0xFFB0 icomon family)',
    services: [0xffb0],
    matches(identity) {
      const n = String(identity && identity.name || '').toLowerCase();
      return /^ssw/.test(n) || n.includes('fg2211') || n.includes('fg2504') || n.includes('dr trust') || n.includes('icomon');
    },

    /*
     * Checksum, verified against every frame of a live SSW533 capture:
     *   last byte == sum(bytes[3] .. bytes[len-2]) mod 32
     * Holds for the 12-byte weight frames, the 34-byte setup frame and the
     * 40-byte record frames alike.
     */
    checksum(b) {
      let s = 0;
      for (let i = 3; i <= b.length - 2; i++) s += b[i];
      return s % 32;
    },
    checksumOk(b) {
      return b.length >= 5 && drTrust.checksum(b) === b[b.length - 1];
    },
    /* Build a 20-byte command packet (SSW532 handshake; optional on the SSW533). */
    packet(bytes) {
      const p = new Uint8Array(20);
      p.set(bytes.slice(0, 19));
      let s = 0;
      for (let i = 3; i <= 18; i++) s += p[i];
      p[19] = s % 32;
      return p;
    },

    async init(ctx) {
      ctx.state.drt = {
        session: null, weightKg: 0, impedanceOhm: null, live: false,
        finalKg: null, finalReported: false, weightOffset: null, recordOffset: null, onScale: false,
      };
      ctx.log('Dr Trust driver: subscribing to the record channel 0xFFB3 and the live weight stream 0xFFB2.', 'ok');
      const a = await ctx.subscribe(0xffb0, 0xffb3);
      const b = await ctx.subscribe(0xffb0, 0xffb2);
      if (!a && !b) ctx.log('Could not subscribe to either channel. Tap the scale to wake it and reconnect.', 'err');
      else ctx.log('Ready. Step on the scale. This firmware streams without a handshake.', 'ok');
    },

    async sendProfile(ctx) {
      const st = ctx.state.drt;
      if (st.session === null) return;
      const prof = ctx.profile();
      const ts = Math.floor(ctx.now() / 1000);
      const h = Math.min(220, Math.max(100, Math.round(prof.heightCm || 170)));
      const age = Math.min(127, Math.max(0, Math.round(prof.age || 30)));
      const packets = [
        [drTrust.packet([0x00, 0x03, 0x00, 0xb0, st.session]), 'session ack'],
        [drTrust.packet([0x01, 0x1a, 0x00, 0xb8, (ts >>> 24) & 0xff, (ts >>> 16) & 0xff, (ts >>> 8) & 0xff, ts & 0xff,
          0x01, 0x4a, 0x01, h, 0x17, 0x70, 0x80 | age, 0x13, 0x88, 0x0f, 0x00]), 'user profile'],
        [drTrust.packet([0x01, 0x1a, 0x01, 0x00, 0x00, 0x00, 0x06, 0x69, 0x63, 0x6f, 0x6d, 0x6f, 0x6e,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'app name'],
      ];
      for (const [p, what] of packets) await ctx.write(0xffb0, 0xffb1, p, what);
    },

    /* Locate a frame marker. Firmware revisions differ by a leading header byte:
       the SSW532 puts the marker at index 1, the SSW533 at index 2. */
    findMarker(b, marker, confirm) {
      for (let i = 1; i <= 3 && i + 1 < b.length; i++) {
        if (b[i] === marker && (!confirm || confirm(i))) return i;
      }
      return -1;
    },

    onFrame(u16, b, ctx) {
      const st = ctx.state.drt;
      if (!st) return null;
      const be16 = (o) => (b[o] << 8) | b[o + 1];
      const be24 = (o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

      // ---------------- live weight stream, 0xFFB2 ----------------
      // layout (marker i): [i]=0x07 [i+2]=0xA2 [i+3]=status [i+5..i+7]=weight BE24, grams
      if (u16 === 0xffb2) {
        const i = drTrust.findMarker(b, 0x07, (k) => b[k + 2] === 0xa2);
        if (i < 0 || i + 7 >= b.length) return null;
        if (st.weightOffset !== i) {
          st.weightOffset = i;
          ctx.log(`  Dr Trust: weight frames aligned at marker offset ${i}; weight is a big-endian 24-bit gram count at byte ${i + 5}.`, 'info');
        }
        const status = b[i + 3];
        const grams = be24(i + 5);
        const kg = Math.round(grams) / 1000;
        const settled = status === 0x00 || status === 0x03;   // 0x00 final (SSW533), 0x03 stable (SSW532)
        const csOk = drTrust.checksumOk(b);
        const warnings = [];
        if (!csOk) warnings.push(`Checksum mismatch (expected 0x${drTrust.checksum(b).toString(16)}, got 0x${b[b.length - 1].toString(16)}) — frame may be corrupt.`);

        let state;
        if (kg === 0) {
          state = 'idle';
          st.onScale = false;
          if (st.finalReported) { st.finalReported = false; st.finalKg = null; st.impedanceOhm = null; }
        } else if (!settled) {
          state = 'settling';
          st.onScale = true;
          st.weightKg = kg;
        } else {
          state = st.finalReported && st.finalKg === kg ? 'held' : 'final';
          st.weightKg = kg;
          if (state === 'final') { st.finalKg = kg; st.finalReported = true; }
        }

        if (state === 'held') return SUPPRESS;   // scale repeats the locked reading forever; do not re-report it

        const res = {
          characteristic: state === 'idle' ? 'Dr Trust — scale idle'
            : state === 'settling' ? 'Dr Trust — live weight (settling)'
            : 'Dr Trust — FINAL WEIGHT',
          spec: 'Dr Trust SSW532/SSW533 vendor protocol (verified against hardware)',
          raw: BCS.hex(b), units: 'SI', flagBits: [], warnings,
          fields: [
            Object.assign(field('Sequence', 0, 1, b[0], '', 'counts up every frame'), { rawHex: BCS.hex(b.slice(0, 1)) }),
            Object.assign(field('Status', i + 3, 1, '0x' + status.toString(16).padStart(2, '0'), '',
              settled ? 'measurement locked' : 'still settling'), { rawHex: BCS.hex(b.slice(i + 3, i + 4)) }),
            Object.assign(field('Weight', i + 5, 3, kg, 'kg', `${grams} g, big-endian 24-bit`), { rawHex: BCS.hex(b.slice(i + 5, i + 8)) }),
            Object.assign(field('Checksum', b.length - 1, 1, '0x' + b[b.length - 1].toString(16).padStart(2, '0'), '',
              csOk ? 'valid: sum(bytes 3..' + (b.length - 2) + ') mod 32' : 'INVALID'), { rawHex: BCS.hex(b.slice(b.length - 1)) }),
          ],
          values: { weight: kg, state },
        };
        if (state === 'idle') res.warnings.push('Nobody on the scale.');
        if (state === 'settling') res.warnings.push('Still settling — not the final reading. Stand still.');
        if (state === 'final') {
          res.warnings.push('This is the final locked weight. The scale will keep repeating it until the next measurement.');
          if (st.impedanceOhm) drTrust.attachBia(res, st, ctx);
        }
        return res;
      }

      if (u16 !== 0xffb3 || b.length < 8) return null;

      // ---------------- setup frame ----------------
      const m = drTrust.findMarker(b, 0x18, (k) => b[k + 1] <= 0x01);
      const m2 = m >= 0 ? m : drTrust.findMarker(b, 0x1d);
      const q = drTrust.findMarker(b, 0x23);
      if (m2 >= 0 && q < 0) {
        st.session = m2 >= 1 ? b[m2 - 1] : b[0];
        ctx.log(`  Dr Trust: session frame (type 0x${b[m2].toString(16)}), session id 0x${st.session.toString(16)}. No handshake needed on this firmware.`, 'info');
        return {
          characteristic: 'Dr Trust session setup', spec: 'Dr Trust vendor protocol',
          raw: BCS.hex(b), units: '', flagBits: [], warnings: [],
          fields: [field('Frame type', m2, 1, '0x' + b[m2].toString(16), '', 'session setup'),
                   field('Session id', Math.max(0, m2 - 1), 1, st.session, '', '')],
          values: { sessionId: st.session },
        };
      }

      // ---------------- measurement record ----------------
      // layout (marker j): [j]=0x23 [j+2]=cmd [j+5..j+6]=impedance BE16 (0.1 ohm)
      //                    [j+8..j+10]=weight BE24, grams
      if (q < 0 || q + 10 >= b.length) return null;
      if (st.recordOffset !== q) {
        st.recordOffset = q;
        ctx.log(`  Dr Trust: record frames aligned at marker offset ${q}.`, 'info');
      }
      const cmd = b[q + 2];
      st.live = cmd === 0xa3 || cmd === 0xa7;
      const rawZ = be16(q + 5);
      const grams = be24(q + 8);
      const kg = grams / 1000;
      const ohm = Math.round(rawZ) / 10;
      const csOk = drTrust.checksumOk(b);
      const res = {
        characteristic: 'Dr Trust measurement record',
        spec: 'Dr Trust SSW532/SSW533 vendor protocol (verified against hardware)',
        raw: BCS.hex(b), units: 'SI', flagBits: [], warnings: [],
        fields: [
          field('Command', q + 2, 1, '0x' + cmd.toString(16), '', st.live ? 'live measurement' : 'cached replay'),
          Object.assign(field('Impedance', q + 5, 2, ohm, 'Ω', `raw ${rawZ}, big-endian, tenths of an ohm`), { rawHex: BCS.hex(b.slice(q + 5, q + 7)) }),
          Object.assign(field('Weight', q + 8, 3, kg, 'kg', `${grams} g, big-endian 24-bit`), { rawHex: BCS.hex(b.slice(q + 8, q + 11)) }),
          field('Checksum', b.length - 1, 1, '0x' + b[b.length - 1].toString(16).padStart(2, '0'), '', csOk ? 'valid' : 'INVALID'),
        ],
        values: { weight: kg, impedanceOhm: ohm },
      };
      if (!csOk) res.warnings.push('Checksum mismatch — frame may be corrupt.');
      if (!(kg > 0)) { res.warnings.push('Record carries no weight.'); return res; }
      if (ohm > 0 && ohm < 1500) { st.impedanceOhm = ohm; st.weightKg = kg; }
      else res.warnings.push(`Impedance ${ohm} ohm is outside a believable range; ignoring it.`);
      if (!st.live) res.warnings.push(`Replayed from the scale's memory (command 0x${cmd.toString(16)}), not measured live.`);
      if (st.impedanceOhm) drTrust.attachBia(res, st, ctx);
      return res;
    },

    /* Derive body composition and cross-check it, because the scale sends none. */
    attachBia(res, st, ctx) {
      const prof = ctx.profile();
      // Carry the impedance onto the final-weight panel too; it arrives on a
      // different characteristic, so without this the final view loses it.
      if (st.impedanceOhm && res.values.impedanceOhm === undefined) {
        res.fields.push(field('Impedance', 0, 0, st.impedanceOhm, 'Ω', 'measured by the scale, from the record frame'));
        res.values.impedanceOhm = st.impedanceOhm;
      }
      const bia = BIA.estimate({
        weightKg: st.weightKg, impedanceOhm: st.impedanceOhm,
        heightCm: prof.heightCm, age: prof.age, sex: prof.sex,
      });
      Object.entries(bia.values).forEach(([k, v]) => {
        if (v === null || typeof v === 'object') return;   // bmrAlternates and the like belong on the panel, not here
        const m = (bia.meta && bia.meta[k]) || {};
        res.fields.push(field(k, 0, 0, v, m.unit || unitFor(k), 'DERIVED, not sent by the scale'));
        res.values[k] = v;
      });
      bia.warnings.forEach((w) => res.warnings.push(w));
      if (bia.unreliable) res.warnings.push('The impedance-derived values above did not survive their range checks.');
    },
  };

  function unitFor(key) {
    if (/Percent$/.test(key)) return '%';
    if (/Kg$/.test(key)) return 'kg';
    if (/Kcal$/.test(key)) return 'kcal';
    if (key === 'bmi') return 'kg/m²';
    return '';
  }

  // =========================================================================
  // Bluetooth SIG standard profile. The measurement decoding lives in bcs.js;
  // this driver only handles the connection choreography (time sync, and the
  // User Data Service consent that most standard scales demand).
  // =========================================================================
  const standard = {
    id: 'standard',
    label: 'Bluetooth SIG standard profile (BCS 0x181B / WSS 0x181D)',
    services: [0x181b, 0x181d, 0x181c, 0x1805],
    matches(identity) { return identity && identity.family === 'standard'; },
    async init(ctx) {
      await ctx.subscribe(0x181d, 0x2a9d);
      await ctx.subscribe(0x181b, 0x2a9c);
      await ctx.subscribe(0x181c, 0x2a9f);
      await ctx.subscribe(0x180f, 0x2a19);
      ctx.log('Standard driver: subscribed to Weight (0x2A9D), Body Composition (0x2A9C) and the User Control Point (0x2A9F).', 'ok');
      ctx.log('If nothing arrives after you step on the scale, use the User Data Service buttons: List users, then Consent.', 'info');
    },
    onFrame() { return null; }, // bcs.js handles the decoding
  };

  // =========================================================================
  // Xiaomi Mi Scale: standard service UUIDs, vendor payload.
  // =========================================================================
  const xiaomi = {
    id: 'xiaomi',
    label: 'Xiaomi Mi Scale (vendor payload on standard service UUIDs)',
    services: [0x181b, 0x181d],
    matches(identity) { return identity && identity.family === 'xiaomi'; },
    async init(ctx) {
      await ctx.subscribe(0x181b, 0x2a9c);
      await ctx.subscribe(0x181d, 0x2a9d);
      ctx.log('Xiaomi driver: Mi scales publish weight in their ADVERTISEMENTS as well as over GATT. If GATT stays quiet, use Scan advertisements.', 'info');
    },
    onFrame(u16, b, ctx) {
      if (b.length !== 10 && b.length !== 13) return null;
      const ScalesDB = ctx.scalesDb;
      if (!ScalesDB) return null;
      const mi = ScalesDB.parseMiScaleRecord(b);
      if (mi.warnings.some((w) => /Not a known Mi Scale record length/.test(w))) return null;
      mi.characteristic = mi.variant;
      mi.spec = 'Xiaomi vendor format';
      mi.units = '';
      const prof = ctx.profile();
      if (mi.values.Weight > 0 && mi.values.Impedance > 0) {
        const bia = BIA.estimate({
          weightKg: mi.values.Weight, impedanceOhm: mi.values.Impedance,
          heightCm: prof.heightCm, age: prof.age, sex: prof.sex,
        });
        Object.entries(bia.values).forEach(([k, v]) => {
          if (v === null || typeof v === 'object') return;
          const m = (bia.meta && bia.meta[k]) || {};
          mi.fields.push(field(k, 0, 0, v, m.unit || unitFor(k), 'DERIVED, not sent by the scale'));
          mi.values[k] = v;
        });
        bia.warnings.forEach((w) => mi.warnings.push(w));
        if (bia.unreliable) mi.warnings.push('The impedance-derived values above did not survive their range checks.');
      }
      return mi;
    },
  };

  // =========================================================================
  // Generic fallback: subscribe to everything notifiable and dump.
  // =========================================================================
  const generic = {
    id: 'generic',
    label: 'Generic (subscribe to everything, dump raw frames)',
    services: [],
    matches() { return true; },
    async init(ctx) {
      ctx.log('Generic driver: subscribing to every notify/indicate characteristic and dumping whatever arrives.', 'info');
      await ctx.subscribeAll();
    },
    onFrame() { return null; },
  };

  const ALL = [drTrust, standard, xiaomi, generic];

  function select(identity) {
    for (const d of ALL) { if (d.matches(identity)) return d; }
    return generic;
  }

  return { ALL, select, drTrust, standard, xiaomi, generic, SUPPRESS, helpers: { be16, be24, le16 } };
});
