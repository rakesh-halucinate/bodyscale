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
  /* ICMeasureStep, as the SDK names the 0xA2 state byte. */
  const STATE_NAMES = {
    0: 'finished', 1: 'weighing',
    2: 'impedance sweep running', 3: 'impedance sweep running',
    4: 'heart rate',
  };

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
    /*
     * Build a command frame.
     *
     *     [0] package index   [1..2] payload length, big-endian
     *     [3] fragment index  [4..]  payload, first byte is the command
     *     [last] trailer = (unit << 5) | (sum(payload) & 0x1F)
     *
     * The header is FOUR bytes, not three. This is the single fault that made
     * every earlier fix pointless: with a three-byte header the command byte
     * lands at index 3, where the scale expects the fragment index, and it
     * reads our profile as length 0x1A00 with fragment 0xB8. Malformed, so
     * discarded before it is ever dispatched. Nothing we sent — the session
     * acknowledgement, the weight, the impedance request — was ever parsed.
     *
     * The same grammar reads every frame the scale sends us, which is how it
     * was confirmed: `06 00 23 00 a7 ...` is package 6, length 35, fragment 0,
     * command 0xA7. The "frame type 0x23" this driver used to search for was
     * that length byte, and the "subtypes" were fragment indices.
     *
     * The trailer covers the payload only. Summing from index 3, as before,
     * wrongly included the fragment byte and agreed with the real rule only
     * because that byte is zero in every single-fragment message.
     */
    packet(payload, pkgIndex = 0, fragIndex = 0, unit = 0) {
      const body = Array.from(payload);
      const p = new Uint8Array(4 + body.length + 1);
      p[0] = pkgIndex & 0xff;
      p[1] = (body.length >> 8) & 0xff;
      p[2] = body.length & 0xff;
      p[3] = fragIndex & 0xff;
      p.set(body, 4);
      let sum = 0;
      for (const b of body) sum += b;
      p[p.length - 1] = ((unit & 0x07) << 5) | (sum & 0x1f);
      return p;
    },

    /*
     * Write one logical message, split across as many 16-byte fragments as it
     * needs. Every fragment carries the same package index and the same total
     * length; only the fragment index advances.
     *
     * The 0xB8 user-info payload is 26 bytes, so it is two fragments — which
     * is what the "app name" packet always was: fragment 1, carrying the tail
     * of the profile including the nickname, not a separate handshake step.
     */
    async writeMessage(ctx, payload, what) {
      const st = ctx.state.drt;
      const pkg = drTrust.nextPkg(st);
      const total = payload.length;
      const CHUNK = 16;
      for (let off = 0, frag = 0; off < total; off += CHUNK, frag += 1) {
        const chunk = payload.slice(off, off + CHUNK);
        const p = new Uint8Array(4 + chunk.length + 1);
        p[0] = pkg;
        p[1] = (total >> 8) & 0xff;
        p[2] = total & 0xff;
        p[3] = frag;
        p.set(chunk, 4);
        let sum = 0;
        for (const b of chunk) sum += b;
        p[p.length - 1] = sum & 0x1f;
        const label = total > CHUNK ? `${what} [${frag + 1}/${Math.ceil(total / CHUNK)}]` : what;
        await ctx.write(0xffb0, 0xffb1, p, label);
      }
    },

    /* The scale de-duplicates on the package index, so it must advance. */
    nextPkg(st) {
      st.pkg = ((st.pkg || 0) + 1) & 0xff;
      return st.pkg;
    },

    async init(ctx) {
      ctx.state.drt = {
        session: null, weightKg: 0, impedanceOhm: null, live: false,
        finalKg: null, finalReported: false, weightOffset: null, recordOffset: null, onScale: false,
        profileSent: false,
        handshakeDone: false, lastLiveKg: 0, writeChain: null, pkg: 0, declarations: 0,
        sweepSeen: false, wireVersion: null, lastRecord: null, liveWeighing: false,
        historySeen: false, emptySweepWarned: false,
      };
      /*
       * Subscribe 0xFFB3, then 0xFFB2, then declare the user — unconditionally.
       *
       * This driver used to wait for an inbound "session frame" before sending
       * anything, and read a "session id" out of it. Neither exists. That byte
       * was the package index, and the frame was the device-info report. The
       * app simply enables both notifications and writes the profile; there is
       * no step where the scale asks to be introduced.
       */
      ctx.log('Dr Trust driver: subscribing to the record channel 0xFFB3.', 'ok');
      const a = await ctx.subscribe(0xffb0, 0xffb3);
      if (!a) {
        ctx.log('Could not subscribe to the record channel. Tap the scale to wake it and reconnect.', 'err');
        return;
      }
      await ctx.subscribe(0xffb0, 0xffb2);
      /*
       * The user is NOT declared here.
       *
       * The capture of the phone app shows two writes in the whole session, in
       * this order: a 3-byte 0xB0 reply, then the 30-byte user info. Both come
       * after the scale has introduced itself, and the user info is sent once.
       * Declaring at connect as well produced two declarations per session
       * where the app sends one.
       */
      ctx.log('Ready. Step on the scale.', 'ok');
    },

    /*
     * Profile writes are queued, never concurrent.
     *
     * These are started from inside frame decoding and deliberately not
     * awaited, so the weight stream cannot stall behind a slow write. That
     * means two can be in flight at once — the opening declaration and a
     * weight correction moments later — and their writes interleave. The
     * order they arrive in decides what the scale believes, so a stale
     * declaration can land after the real one and quietly undo it.
     */
    async sendProfile(ctx, weightKg) {
      const st = ctx.state.drt;
      const prior = st.writeChain || Promise.resolve();
      let release;
      st.writeChain = new Promise((r) => { release = r; });
      try { await prior; } catch (e) { /* a failed write must not block the next */ }
      try {
        return await drTrust.writeProfile(ctx, weightKg);
      } finally { release(); }
    },

    /*
     * Declare the user, and ask for an impedance measurement.
     *
     * Command 0xC0, 30 payload bytes, ONE unfragmented write. This is not
     * inferred: a Bluetooth capture of the phone app talking to this exact
     * scale contains precisely two writes in the whole session —
     *
     *     handle 0x001d   0b 00 03 ...    8 bytes   a 3-byte 0xB0 reply
     *     handle 0x001d   0c 00 1e ...   35 bytes   a 30-byte user info
     *
     * — and 0x001e is 30. Counting the writes in
     * ICBleScaleGeneralProtocolV2::encodeUserInfo_C0 (libICBleProtocol.so
     * @0x13e208, command byte at 0x13eb50) gives 24 fixed bytes plus a
     * length-prefixed nickname; with "icomon" that is exactly 30.
     *
     * Two things this corrects beyond the command byte. The app declares the
     * user ONCE per session, not at every opportunity. And it sends the whole
     * payload in a single write: 35 bytes fits the negotiated MTU, so the
     * 16-byte fragmentation was wrong as well.
     *
     *   [0]      0xC0
     *   [1..4]   unix time, big-endian
     *   [5..6]   UTC offset in minutes, sign-magnitude
     *   [7]      user index
     *   [8]      height in cm
     *   [9..10]  weight x100
     *   [11]     age, 0x80 set for male
     *   [12..13] target weight x100
     *   [14..15] start weight x100
     *   [16]     function bitmask — bit 0 is fun_open_imp
     *   [17..20] user id
     *   [21..22] reserved
     *   [23]     nickname length
     *   [24..]   nickname
     */
    async writeProfile(ctx, weightKg) {
      const prof = ctx.profile() || {};
      const ts = Math.floor(ctx.now() / 1000);
      const h = Math.min(220, Math.max(100, Math.round(prof.heightCm || 170)));
      const age = Math.min(127, Math.max(0, Math.round(prof.age || 30)));
      const male = String(prof.sex || 'male').toLowerCase() !== 'female';
      const declaredKg = Math.min(300, Math.max(10, weightKg || prof.weightKg || 60));
      const dw = Math.round(declaredKg * 100);

      // Sign-magnitude, not two's complement: bit 15 marks a negative offset.
      const tzMin = -new Date().getTimezoneOffset();
      const tz = (tzMin < 0 ? 0x8000 : 0) | (Math.abs(tzMin) & 0x7fff);

      // bit0 impedance, bit1 balance, bit2 heart rate, bit3 gravity. Bit 0 is
      // the only thing in this protocol that asks for a body-composition sweep.
      const FUNCTIONS = 0x0f;
      const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
      const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
      const NICK = [0x69, 0x63, 0x6f, 0x6d, 0x6f, 0x6e];             // "icomon"

      const payload = [
        0xc0, ...be32(ts), ...be16(tz), 0x01, h,
        ...be16(dw), (male ? 0x80 : 0x00) | age,
        ...be16(dw), ...be16(dw), FUNCTIONS, ...be32(1), 0x00, 0x00,
        NICK.length, ...NICK,
      ];
      if (payload.length !== 30) {
        ctx.log(`  Dr Trust: profile payload is ${payload.length} bytes, expected 30.`, 'warn');
      }

      /*
       * Say when this is a placeholder.
       *
       * A deferred capture sends no profile by design, so these are stand-ins.
       * The scale runs its sweep on them regardless — what it needs is a
       * well-formed frame with the impedance bit set, not a true one — but a
       * log line reading "180 cm, 39y" when nobody supplied that is the kind
       * of thing that costs an afternoon later.
       */
      const supplied = prof.heightCm || prof.age || prof.sex;
      const what = `user profile 0xC0 (${h} cm, ${age}y, ${male ? 'male' : 'female'},`
        + ` declared ${declaredKg} kg, impedance requested`
        + `${supplied ? '' : ' — placeholder, host sent no profile'})`;
      const st = ctx.state.drt;
      st.handshakeDone = true;
      await ctx.write(0xffb0, 0xffb1, drTrust.packet(payload, drTrust.nextPkg(st)), what);
    },

    /*
     * Acknowledge a frame from the scale.
     *
     * The SDK replies 0xB0 to the device-info frame and to every record, and
     * drops the connection when the acknowledgement does not come. The payload
     * echoes the package index of the frame being answered.
     */
    async ack(ctx, forPkg) {
      const st = ctx.state.drt;
      await ctx.write(0xffb0, 0xffb1,
        drTrust.packet([0xb0, forPkg & 0xff, 0x00], drTrust.nextPkg(st)),
        `ack of package 0x${(forPkg & 0xff).toString(16)}`);
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
      if (u16 === 0xffb2) {
        /*
         * Command 0xA2, the live weight stream, read at fixed offsets:
         *
         *   [4] 0xA2   [5] state   [6..9] packed BE32   [10] heart rate
         *
         * The packed word is 14 flag bits and an 18-bit gram count, masked
         * with 0x3FFFF. The old big-endian 24-bit read at byte 7 worked only
         * because those upper bits are zero at these weights.
         *
         * THE STATE BYTE WAS BACKWARDS, and it is the most expensive mistake
         * in this file. The SDK maps it:
         *
         *   1  weighing
         *   2  impedance sweep running   <- this is the P-1 display
         *   3  impedance sweep running
         *   4  heart rate
         *
         * This driver treated 3 as "stable, final weight". So the instant the
         * scale began the sweep we have spent every run waiting for, we
         * declared the weight final, latched it, suppressed everything after
         * it and closed the link — cutting off the measurement at the exact
         * moment it started. The scale was being interrupted, not silent.
         */
        /*
         * Two header lengths exist in this family and the command byte is how
         * they are told apart, not a search for a magic number.
         *
         *   V2 (SSW533): [0]pkg [1..2]len [3]frag [4]cmd [5]state [6..9]packed
         *   V1 (SSW532): [0]pkg [1]len   [2]frag [3]cmd [4]state [6..8]weight
         *
         * Guessing this by hunting for a 0x07 byte is what made the driver
         * pattern-match on payload *length* and mis-read every field after it.
         */
        const v2 = b[4] === 0xa2;
        const v1 = !v2 && b[3] === 0xa2;
        if (!v2 && !v1) return null;
        if (st.wireVersion !== (v2 ? 2 : 1)) {
          st.wireVersion = v2 ? 2 : 1;
          st.weightOffset = v2 ? 2 : 1;      // retained: the header length
          ctx.log(`  Dr Trust: ${v2 ? 'V2' : 'V1'} framing (command at byte ${v2 ? 4 : 3}).`, 'info');
        }
        const wireState = v2 ? b[5] : b[4];
        // V2 packs 14 flag bits above an 18-bit gram count; V1 is a plain BE24.
        const grams = v2
          ? (((b[6] << 24) >>> 0) + (b[7] << 16) + (b[8] << 8) + b[9]) & 0x3ffff
          : be24(6);
        if (!Number.isFinite(grams)) return null;
        const kg = Math.round(grams) / 1000;

        /*
         * The sweep states are V2 only. On the older framing 0x03 means a
         * stable reading, which is what openScale's SSW532 handler treats it
         * as, and we have no vendor evidence to overrule that for V1.
         */
        if (v2 && (wireState === 2 || wireState === 3)) {
          if (!st.sweepSeen) {
            st.sweepSeen = true;
            st.liveWeighing = true;
            ctx.log(`  Dr Trust: the scale has started its impedance sweep (state ${wireState}) — `
              + 'this is the P-1 phase. Holding the link open and staying out of its way.', 'ok');
          }
          // Emphatically not a final weight: report nothing and keep listening.
          return SUPPRESS;
        }
        if (v2 && wireState === 4) {
          ctx.log('  Dr Trust: heart-rate phase (state 4).', 'info');
          return SUPPRESS;
        }

        // Only a weight of zero, or the scale falling back to state 0 after a
        // completed run, ends the reading. State 1 is someone standing on it.
        const settled = v2 ? wireState === 0x00 : (wireState === 0x00 || wireState === 0x03);
        const csOk = drTrust.checksumOk(b);
        const warnings = [];
        if (!csOk) warnings.push(`Checksum mismatch (expected 0x${drTrust.checksum(b).toString(16)}, got 0x${b[b.length - 1].toString(16)}) — frame may be corrupt.`);

        let state;
        if (kg === 0) {
          state = 'idle';
          st.onScale = false;
          if (st.finalReported) {
            st.finalReported = false; st.finalKg = null; st.impedanceOhm = null;
            st.handshakeDone = false; st.lastLiveKg = 0;
          }
        } else if (!settled) {
          state = 'settling';
          st.onScale = true;
          // Somebody is on the scale now, so a record from here on is theirs.
          st.liveWeighing = true;
          st.weightKg = kg;
          /*
           * Nothing is written here.
           *
           * This used to re-declare the profile whenever the live weight
           * steadied, on my reasoning that the scale sets its measuring
           * current from the declared weight and so should be told the real
           * one early. The vendor app does no such thing: it declares the user
           * once and then only listens. Combined with the declaration at
           * connect and the one after the device introduces itself, that made
           * twelve user-info frames in a burst where the app sends two — and a
           * scale being re-declared every few hundred milliseconds has every
           * reason to keep resetting instead of measuring.
           *
           * The declared weight is the user's own stored weight from their
           * profile, not the live reading. We do not have one, and inventing a
           * stream of them is worse than sending none.
           */
        } else {
          state = st.finalReported && st.finalKg === kg ? 'held' : 'final';
          st.weightKg = kg;
          if (state === 'final') {
            st.finalKg = kg; st.finalReported = true;
            st.liveWeighing = true;
            /*
             * Nothing is sent here any more.
             *
             * This used to write 0xBD 0x09 as an "start the impedance program"
             * request. There is no such command: 0xBD is the SDK's generic
             * vendor pass-through, reachable only from an explicit settings
             * action, and the app never sends it during a measurement. The
             * scale decides for itself, once a well-formed profile has asked
             * for impedance, and reports it in the weight stream's state byte.
             */
          }
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
            Object.assign(field('State', v2 ? 5 : 4, 1, '0x' + wireState.toString(16).padStart(2, '0'), '',
              STATE_NAMES[wireState] || 'unknown'), { rawHex: BCS.hex(b.slice(v2 ? 5 : 4, v2 ? 6 : 5)) }),
            Object.assign(field('Weight', 6, 4, kg, 'kg', `${grams} g, low 18 bits of a packed big-endian word`),
              { rawHex: BCS.hex(b.slice(6, 10)) }),
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

      /*
       * Route by the command byte at index 4. No marker search: the bytes this
       * used to hunt for — 0x18, 0x1d, 0x23 — are the low half of the 16-bit
       * length field, so the driver was pattern-matching on payload size and
       * silently dropping any frame whose length it had not seen before.
       */
      const cmdByte = b[4];
      const payloadLen = (b[1] << 8) | b[2];
      const fragment = b[3];
      const pkg = b[0];

      // ---------------- device info, 0xAA / 0xA1 ----------------
      if (cmdByte === 0xaa || cmdByte === 0xa1) {
        /*
         * The scale introducing itself. Byte 0 is its package index, not a
         * "session id" — there is no such thing in this protocol. The SDK
         * answers with a 0xB0 reply echoing that index, then declares the
         * user once.
         */
        st.session = pkg;
        ctx.log(`  Dr Trust: device info (command 0x${cmdByte.toString(16)}), package `
          + `0x${pkg.toString(16)} — acknowledging, then declaring the user.`, 'ok');

        Promise.resolve(drTrust.ack(ctx, pkg))
          .then(() => {
            if (st.profileSent) return null;
            st.profileSent = true;
            return drTrust.sendProfile(ctx, st.weightKg || undefined);
          })
          .catch((e) => ctx.log(`  Dr Trust: handshake failed: ${e.message}`, 'warn'));

        return {
          characteristic: 'Dr Trust device info', spec: 'Dr Trust vendor protocol',
          raw: BCS.hex(b), units: '', flagBits: [], warnings: [],
          fields: [
            field('Command', 4, 1, '0x' + cmdByte.toString(16), '', 'device info'),
            field('Package index', 0, 1, pkg, '', 'echoed back in the acknowledgement'),
          ],
          values: { packageIndex: pkg },
        };
      }

      // ---------------- measurement record, 0xA7 live / 0xA5 history --------
      if (cmdByte !== 0xa7 && cmdByte !== 0xa5) return null;

      /*
       * 0xA5 is history. 0xA7 is a live measurement. Only one of them is an
       * answer to "measure me now".
       *
       * The protocol has always drawn this line and this driver ignored it,
       * accepting both. The scale uploads its stored record when the record
       * channel opens, and again after a weighing it declined to perform, so
       * every run came back with the same bytes as the first successful
       * measurement — the same weight to 0.05 kg, the same ten impedances —
       * and the display never showed P-1 because nothing was ever measured.
       *
       * Gating on "has anyone stood on the scale" was not enough: the second
       * dump arrives after they have. The command byte is the fact; the
       * inference was a guess standing in for it.
       */
      if (cmdByte === 0xa5) {
        if (!st.historySeen) {
          st.historySeen = true;
          ctx.log('  Dr Trust: this is a stored record (command 0xA5), not a live '
            + 'measurement. Ignoring it and waiting for the scale to measure. If it never '
            + 'does, step off, let the display clear, and step on again.', 'warn');
        }
        return null;
      }

      /*
       * A live record still has to follow someone standing on the scale. The
       * firmware has been seen to send 0xA7 carrying stored values on connect,
       * before the weight stream has said anything.
       */
      if (!st.liveWeighing) {
        ctx.log('  Dr Trust: ignoring a record that arrived before anyone stood on the '
          + 'scale — waiting for a live one.', 'warn');
        return null;
      }

      const stamp = ((b[5] << 24) >>> 0) + (b[6] << 16) + (b[7] << 8) + b[8];
      const packed = ((b[9] << 24) >>> 0) + (b[10] << 16) + (b[11] << 8) + b[12];
      const grams = packed & 0x3ffff;
      const kg = Math.round(grams) / 1000;
      const heartRate = b[13];
      const count = b[14];

      const impedances = [];
      let truncated = false;
      for (let n = 0; n < count; n += 1) {
        const at = 15 + n * 2;
        if (at + 1 >= b.length) { truncated = true; break; }
        impedances.push(((b[at] << 8) | b[at + 1]) / 10);
      }
      const measured = impedances.filter((v) => v > 0);

      /*
       * Ten values are two groups of five, and each group is a segmental set.
       *
       * A real reading from this scale:
       *
       *   27.8  325.3 333.5 320.4 350.9   |   25.7  294.0 299.7 285.5 318.3
       *   ^^^^  ^^^^^^^^^^^^^^^^^^^^^^^       ^^^^  ^^^^^^^^^^^^^^^^^^^^^^^
       *   trunk        four limbs             trunk        four limbs
       *
       * That shape is not a guess: trunk impedance is characteristically 20-30
       * ohm because the path is short and wide, while a limb is 250-350. Both
       * groups show it, in the same position, which is what a segmental set
       * looks like and is why the count is ten rather than five — two passes,
       * almost certainly at two frequencies.
       *
       * The whole-body figure the BIA equations want is a single hand-to-foot
       * path, so it is one arm plus the trunk plus one leg. Summing all ten,
       * which is what the first version of this did, walks every limb twice and
       * produced 2581 ohm: outside any physical band, so the trust rules threw
       * the whole reading away.
       *
       * WHICH group matters, and it is the second one.
       *
       * Both groups are segmental sets, but their limb values differ by about
       * 10% — almost certainly two frequencies. Checked against the scale's
       * own display for a 97.7 kg reading:
       *
       *   scale shows 40.7 % fat    -> implies 606.8 Ω
       *   scale shows 54 kg muscle  -> implies 618.9 Ω
       *   group 1 hand-to-foot          674.7 Ω  -> 44.1 % fat, 51.4 kg muscle
       *   group 2 hand-to-foot          606.4 Ω  -> 40.7 % fat, 54.7 kg muscle
       *
       * Group 2 reproduces the body-fat figure exactly, and the muscle mass
       * follows from it without being fitted — one number was matched and the
       * other agreed on its own, which is what makes this a confirmation
       * rather than a curve fit.
       *
       * Still inferred: the order WITHIN a group comes from the magnitudes,
       * not from the vendor code. Only the whole-body path is corroborated.
       */
      const group = measured.length >= 10 ? measured.slice(5, 10)
        : (measured.length >= 5 ? measured.slice(0, 5) : measured);
      let segments = null;
      let ohm = 0;
      if (group.length === 5) {
        const [trunk] = group;
        segments = {
          trunk,
          rightArm: group[1], leftArm: group[2], rightLeg: group[3], leftLeg: group[4],
          all: measured,
        };
        // Hand to foot down one side: the path the equations assume.
        ohm = group[1] + trunk + group[3];
      } else {
        ohm = measured.reduce((a, v) => a + v, 0);
      }

      if (count > 0) {
        ctx.log(`  Dr Trust: live record (0x${cmdByte.toString(16)}) with ${count} impedance slot(s), `
          + `${measured.length} non-zero`
          + (measured.length ? `: ${measured.join(', ')} Ω (sum ${Math.round(ohm * 10) / 10})` : ''),
        measured.length ? 'ok' : 'warn');
      }

      const csOk = drTrust.checksumOk(b);
      const res = {
        characteristic: 'Dr Trust measurement record',
        spec: 'Dr Trust SSW533 vendor protocol (decodeUploadData_A5A7)',
        raw: BCS.hex(b), units: 'SI', flagBits: [], warnings: [],
        fields: [
          field('Command', 4, 1, '0x' + cmdByte.toString(16), '',
            cmdByte === 0xa7 ? 'live measurement' : 'replayed from the scale\'s memory'),
          field('Weight', 9, 4, kg, 'kg', `${grams} g, low 18 bits of a packed word`),
          field('Impedance count', 14, 1, count, '', 'declared by the scale, not assumed'),
          Object.assign(field('Impedance', 15, count * 2,
            measured.length ? Math.round(ohm * 10) / 10 : null, 'Ω',
            measured.length
              ? `${measured.length} of ${count} slots measured: ${measured.join(', ')}`
              : `all ${count} slots zero — the sweep did not complete`),
          { rawHex: BCS.hex(b.slice(15, Math.min(b.length - 1, 15 + count * 2))) }),
          field('Heart rate', 13, 1, heartRate || null, 'bpm', heartRate ? '' : 'not measured'),
          field('Checksum', b.length - 1, 1,
            '0x' + b[b.length - 1].toString(16).padStart(2, '0'), '', csOk ? 'valid' : 'INVALID'),
        ],
        values: {
          weight: kg > 0 ? kg : undefined,
          impedanceOhm: ohm > 0 ? Math.round(ohm * 10) / 10 : null,
          impedanceCount: count,
          impedances,
          heartRate: heartRate || null,
          deviceTimestamp: stamp > 1600000000 && stamp < 2200000000 ? stamp : null,
        },
      };
      if (!csOk) res.warnings.push('Checksum mismatch — frame may be corrupt.');
      if (truncated) {
        res.warnings.push(`The scale declared ${count} impedance values but the frame ended early; `
          + `${impedances.length} were read.`);
      }
      if (payloadLen + 5 !== b.length) {
        res.warnings.push(`Frame is ${b.length} bytes but declares a ${payloadLen}-byte payload `
          + `(expected ${payloadLen + 5}).`);
      }

      /*
       * Say when the scale is repeating itself.
       *
       * Given a profile it does not accept, this firmware does not refuse — it
       * hands back its stored record. That came back identical to the previous
       * reading down to the weight, 97.55 kg and all ten impedances, and
       * nothing on screen distinguished it from a fresh measurement. A stale
       * number presented as a new one is worse than an error.
       */
      /*
       * Only a record with values can be a replay.
       *
       * While the sweep is running the scale emits records with every slot
       * still empty — that is it saying "not finished", not "here is the same
       * answer again". Warning on those told the user their scale had replayed
       * stored data at the exact moment it was, in fact, measuring.
       */
      const signature = `${grams}:${impedances.join(',')}`;
      if (measured.length > 0 && signature === st.lastRecord) {
        res.warnings.push('This record is identical to the previous one, down to the weight '
          + 'and every impedance value. The scale replayed what it had stored rather than '
          + 'measuring: its display would not have shown P-1. Step off, wait for it to clear, '
          + 'and measure again.');
        ctx.log('  Dr Trust: this record repeats the last one exactly — the scale replayed '
          + 'stored data instead of measuring.', 'warn');
      }
      st.lastRecord = signature;

      if (kg > 0) st.weightKg = kg;
      if (ohm > 0) {
        st.impedanceOhm = Math.round(ohm * 10) / 10;
        st.segments = impedances;
        res.warnings.push(`The scale sent ${measured.length} impedance values `
          + `(${measured.join(', ')} Ω). How they combine into one whole-body figure is not yet `
          + 'established, so the sum is used provisionally and every value derived from it should '
          + 'be checked against the vendor app before it is trusted.');
      } else if (count > 0) {
        /*
         * The sweep started and produced nothing. This is the state to be
         * precise about, because it is the one that looks like a broken
         * program and is usually a broken circuit: an 8-electrode measurement
         * needs all four foot pads AND both hands, and it needs them for the
         * whole ten seconds the display shows P-1. Letting go at nine seconds
         * gives exactly this — a record with every slot still zero.
         */
        if (!st.emptySweepWarned) {
          st.emptySweepWarned = true;
          ctx.log('  Dr Trust: the sweep is running but every impedance slot is still empty. '
            + 'Keep BOTH hands on the handle and BARE feet on all four pads until the display '
            + 'stops showing P-1 — the circuit runs hand to foot, and breaking it at any point '
            + 'restarts the measurement.', 'warn');
        }
        res.warnings.push(`The scale ran its sweep and returned ${count} impedance slots with `
          + 'nothing in them. The circuit runs hand to foot: it needs both hands on the handle '
          + 'and bare feet on all four pads, held for the whole time the display shows P-1.');
      }
      if (cmdByte === 0xa5) {
        res.warnings.push('Replayed from the scale\'s memory, not measured live.');
      }
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
