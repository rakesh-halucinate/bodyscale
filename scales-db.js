/*
 * scales-db.js — device knowledge base for BLE body scales.
 *
 * PROVENANCE / LICENSING NOTE
 * ---------------------------
 * The protocol FACTS below (which service and characteristic UUIDs a scale exposes, what
 * advertised names it uses, whether it talks standard GATT or a vendor protocol, and the byte
 * layout of a few well-known frames) were researched from the openScale project
 * (https://github.com/oliexdev/openScale, GPL-3.0) and from public protocol documentation.
 *
 * openScale is GPL-3.0. NO openScale source code is copied here — copying it would place this
 * project under GPL-3.0 as well. What is reproduced is factual interface data (UUID numbers,
 * device name strings, field offsets), which is not the copyrightable expression of that project.
 * Every decoder below is independently written JavaScript. Credit for the reverse engineering
 * belongs to olie.xdev and the openScale contributors.
 *
 * If you would rather have openScale's actual implementations, the correct move is to license
 * this project under GPL-3.0 and port them deliberately — not to paste them in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bcs.js'));
  else root.ScalesDB = factory(root.BCS);
})(typeof self !== 'undefined' ? self : this, function (BCS) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Protocol families. `standard` is the only one this project can decode fully
  // from the specification; everything else needs per-vendor reverse engineering.
  // ---------------------------------------------------------------------------
  const FAMILIES = {
    standard: {
      id: 'standard',
      label: 'Bluetooth SIG standard profile (BCS 0x181B / WSS 0x181D)',
      decodable: 'full',
      advice: 'Connect and subscribe to 0x2A9C and 0x2A9D. This viewer decodes these completely. ' +
              'Many of these scales also need the User Data Service (0x181C) consent handshake before they will indicate a measurement.',
    },
    xiaomi: {
      id: 'xiaomi',
      label: 'Xiaomi Mi Scale (borrows 0x181B/0x181D, vendor payload)',
      decodable: 'partial',
      advice: 'Uses the standard service UUIDs but NOT the standard 0x2A9C layout. Weight arrives either as ' +
              'advertisement service data or on a vendor history characteristic. This viewer decodes the ' +
              'well-known 10-byte and 13-byte Mi records.',
    },
    broadcast: {
      id: 'broadcast',
      label: 'Broadcast-only (data in advertisements, no GATT connection)',
      decodable: 'none',
      advice: 'This scale never accepts a GATT connection for measurements — it puts the reading in its ' +
              'advertising packets. Web Bluetooth cannot scan advertisements without the experimental ' +
              'requestLEScan flag, so a connect-based viewer will see nothing. Use the Scan advertisements button.',
    },
    vendorFFB0: {
      id: 'vendorFFB0',
      label: 'Vendor service 0xFFB0 (very common white-label BIA scale)',
      decodable: 'none',
      advice: 'Proprietary frames on 0xFFB2 (notify) / 0xFFB1 (write). Body composition is usually computed ' +
              'on the phone from weight + impedance, not sent by the scale. Raw frames are dumped for you.',
    },
    vendorFFF0: {
      id: 'vendorFFF0',
      label: 'Vendor service 0xFFF0 (common white-label scale)',
      decodable: 'none',
      advice: 'Proprietary frames on 0xFFF1/0xFFF4 (notify). Raw frames are dumped for you.',
    },
    vendorFFE0: {
      id: 'vendorFFE0',
      label: 'Vendor service 0xFFE0 (older Beurer/Sanitas, QN-Scale/Yolanda, Yunmai)',
      decodable: 'none',
      advice: 'Proprietary frames on 0xFFE1/0xFFE4. Often needs a magic init write before it sends anything.',
    },
    vendor8A: {
      id: 'vendor8A',
      label: 'Vendor service 0x78B2 / 0x7802 (Medisana, Trisa, Weight Gurus)',
      decodable: 'none',
      advice: 'Proprietary frames on 0x8A21/0x8A22/0x8A82. Usually requires a challenge-response pairing write.',
    },
    vendor1A10: {
      id: 'vendor1A10',
      label: 'Vendor service 0x1A10 (Renpho ES-CS20M / ES-26BB, FitIndex)',
      decodable: 'none',
      advice: 'Proprietary frames on 0x2A10 (notify) / 0x2A11 (write).',
    },
    unknown: {
      id: 'unknown',
      label: 'Unrecognised',
      decodable: 'none',
      advice: 'Not in the device database. Everything the device sends is still dumped as raw hex, and the ' +
              'heuristic scanner will guess where a weight value might sit in each frame.',
    },
  };

  // ---------------------------------------------------------------------------
  // Vendor service UUIDs. Web Bluetooth hides any service that was not named in
  // optionalServices at requestDevice() time, so the viewer must ask for all of
  // these up front or it will see nothing but the standard services.
  // ---------------------------------------------------------------------------
  const STANDARD_SERVICES = [0x1800, 0x1801, 0x1805, 0x180a, 0x180f, 0x181b, 0x181c, 0x181d];

  const VENDOR_SERVICES = [
    0x00ff, 0x1a10, 0x7802, 0x7892, 0x78b2, 0x8a21, 0x8a22, 0x8a24, 0x8a81, 0x8a82,
    0xae00, 0xfaa0, 0xfe95, 0xfea0, 0xfee0, 0xfee7, 0xff01, 0xff02, 0xffa0, 0xffb0,
    0xffc0, 0xffd0, 0xffe0, 0xffe4, 0xffe5, 0xffe9, 0xfff0, 0xfff5, 0xfff6, 0xffff,
  ];

  const VENDOR_UUID_FAMILY = {
    0xffb0: 'vendorFFB0', 0xfff0: 'vendorFFF0', 0xfff6: 'vendorFFF0',
    0xffe0: 'vendorFFE0', 0xffe4: 'vendorFFE0', 0xffe5: 'vendorFFE0', 0xffe9: 'vendorFFE0',
    0x78b2: 'vendor8A', 0x7802: 'vendor8A', 0x7892: 'vendor8A', 0x8a21: 'vendor8A',
    0x8a22: 'vendor8A', 0x8a81: 'vendor8A', 0x8a82: 'vendor8A',
    0x1a10: 'vendor1A10', 0xfe95: 'xiaomi',
  };

  // ---------------------------------------------------------------------------
  // Device recognition by advertised name. Patterns are lowercase substrings.
  // `family` says what the scale actually speaks; `note` is shown to the user.
  // ---------------------------------------------------------------------------
  const DEVICES = [
    // --- Bluetooth SIG standard profile: the scales this project decodes properly ---
    { match: ['bf105', 'bf720'], name: 'Beurer BF105 / BF720', family: 'standard', note: 'Standard BCS + User Data Service consent required.' },
    { match: ['bf1000'], name: 'Beurer BF1000', family: 'standard', note: 'Standard BCS + UDS consent required.' },
    { match: ['bf950', 'sbf77', 'sbf76'], name: 'Beurer BF950 / Sanitas SBF76-77', family: 'standard', note: 'Standard BCS + UDS consent required.' },
    { match: ['bf500'], name: 'Beurer BF500', family: 'standard', note: 'Standard BCS + UDS consent required.' },
    { match: ['bf600', 'bf850'], name: 'Beurer BF600 / BF850', family: 'standard', note: 'Standard BCS + UDS consent required.' },
    { match: ['bf450'], name: 'Beurer BF450', family: 'standard', note: 'Standard 0x2A9C, plus impedance on a vendor 0xFFF6 characteristic.' },
    { match: ['sbf72', 'sbf73', 'bf915'], name: 'Sanitas SBF72 / SBF73 / Beurer BF915', family: 'standard', note: 'Standard BCS + UDS consent required.' },
    { match: ['shape100', 'shape200', 'shape50', 'style100'], name: 'Soehnle Shape / Style', family: 'standard', note: 'Standard services with User Data Service; measurement history read after consent.' },
    { match: ['huawei scale', 'hagrid', 'ah100', 'ch100'], name: 'Huawei Scale (WSP models)', family: 'standard', note: 'Some Huawei models expose standard 0x2A9C/0x2A9D; others use vendor 0xFAA0.' },
    { match: ['renpho', 'es-wbe28'], name: 'Renpho (standard-profile models)', family: 'standard', note: 'Some Renpho models expose the full standard profile; others use vendor 0x1A10 or 0xFFF0.' },

    // --- Xiaomi ---
    { match: ['mibcs', 'mibfs', 'mi scale2', 'mi_scale', 'mi body composition'], name: 'Xiaomi Mi Body Composition Scale (v2)', family: 'xiaomi', note: '13-byte Mi record with impedance; weight also broadcast in 0x181B advertisement service data.' },
    { match: ['mi scale', 'xiaomi scale'], name: 'Xiaomi Mi Scale (v1)', family: 'xiaomi', note: '10-byte Mi record, weight only; broadcast in 0x181D advertisement service data.' },
    { match: ['xiaomi s800', 'mi s400', 's400'], name: 'Xiaomi S400 / S800', family: 'broadcast', note: 'Broadcast-only; not reachable by a GATT connection.' },

    // --- Broadcast-only ---
    { match: ['chipsea-ble', 'yoda0', 'yoda1', 'adv'], name: 'OKOK / Chipsea broadcast scale', family: 'broadcast', note: 'Weight and impedance in manufacturer data; no GATT measurement.' },
    { match: ['aaa002', 'aaa007', 'aaa013'], name: 'AAAx broadcast scale', family: 'broadcast', note: 'Weight in manufacturer data.' },
    { match: ['ailink'], name: 'AiLink broadcast scale', family: 'broadcast', note: 'Weight in manufacturer data frames.' },
    { match: ['yunmai-x', 'yunmai x'], name: 'Yunmai X', family: 'broadcast', note: 'Broadcast-only variant.' },
    { match: ['etekcity fit 8s', 'fit 8s'], name: 'Etekcity Fit 8S', family: 'broadcast', note: 'Broadcast-only.' },
    { match: ['eufy c20'], name: 'Eufy Smart Scale C20', family: 'broadcast', note: 'Broadcast-only.' },
    { match: ['weight scale'], name: 'Sinocare / generic broadcast scale', family: 'broadcast', note: 'Generic name; broadcast-only in openScale.' },

    // --- Vendor 0xFFB0 family ---
    { match: ['icomon', 'swan', 'yg '], name: 'MGB / iComon / Swan / YG', family: 'vendorFFB0', note: 'Very common white-label BIA scale.' },
    { match: ['fittrack'], name: 'FitTrack Dara', family: 'vendorFFB0' },
    { match: ['bia scale', '5331891'], name: 'Taylor BIA scale', family: 'vendorFFB0' },
    { match: ['ssw532', 'ssw', 'fg2211'], name: 'Dr Trust SSW532', family: 'vendorFFB0' },
    { match: ['healthkeep'], name: 'HealthKeep 280', family: 'vendorFFB0' },
    { match: ['runstar-r6', 'runstar'], name: 'Runstar R5 / R6', family: 'vendorFFB0' },
    { match: ['robi'], name: 'Robi S9', family: 'vendorFFB0' },
    { match: ['relaxmedic'], name: 'Relaxmedic', family: 'vendorFFB0' },
    { match: ['1byone scale'], name: '1byone (newer)', family: 'vendorFFB0' },
    { match: ['eebbl', 'p1'], name: 'EEBBL / P1', family: 'vendorFFB0' },
    { match: ['bbs8107', 'hoffen'], name: 'Hoffen BBS-8107', family: 'vendorFFB0' },
    { match: ['activeera', 'bf06'], name: 'ActiveEra BF-06', family: 'vendorFFB0' },

    // --- Vendor 0xFFF0 family ---
    { match: ['electronic scale'], name: 'Excelvan CF36x (generic name)', family: 'vendorFFF0' },
    { match: ['yunchen', 'hesley'], name: 'Hesley / Yunchen', family: 'vendorFFF0' },
    { match: ['picooc', 'latin-'], name: 'Picooc', family: 'vendorFFF0' },
    { match: ['inlife'], name: 'Inlife', family: 'vendorFFF0' },
    { match: ['mengii', 'dg-s038h'], name: 'Digoo DG-S038H', family: 'vendorFFF0' },
    { match: ['vitafit'], name: 'Vitafit VT701', family: 'vendorFFF0' },
    { match: ['t9120', 't9146', 't9147'], name: '1byone (older)', family: 'vendorFFF0' },
    { match: ['eufy t9148', 'eufy t9149'], name: 'Eufy P2 (T9148/T9149)', family: 'vendorFFF0' },
    { match: ['dara 2.0'], name: 'Hume Dara 2.0', family: 'vendorFFF0' },
    { match: ['cult'], name: 'Cult Smart Scale Pro', family: 'vendorFFF0' },
    { match: ['senssun fat', 'senssun'], name: 'Senssun Fat', family: 'vendorFFF0' },

    // --- Vendor 0xFFE0 family ---
    { match: ['yunmai-ism', 'yunmai-isse', 'yunmai-isc2p', 'yunmai-signal', 'yunmai'], name: 'Yunmai (Mini / SE / Premium)', family: 'vendorFFE0' },
    { match: ['qn-scale', 'yolanda', 'qn scale'], name: 'QN-Scale / Yolanda', family: 'vendorFFE0', note: 'Also sold as Renpho, Arboleaf, Innotech and many others.' },
    { match: ['openscale'], name: 'Custom openScale (Arduino/ESP32)', family: 'vendorFFE0' },
    { match: ['sbf70', 'sbf75', 'bf700', 'bf710', 'silvercrest'], name: 'Beurer BF700/BF710 / Sanitas SBF70 (older)', family: 'vendorFFE0', note: 'Older Beurer/Sanitas use vendor 0xFFE0, NOT the standard profile.' },

    // --- Other vendor ---
    { match: ['013197', '013198', '0202b6', '0203b', 'bs444', 'bs440'], name: 'Medisana BS444 / BS440', family: 'vendor8A' },
    { match: ['trisa'], name: 'Trisa Body Analyze', family: 'vendor8A' },
    { match: ['weight gurus'], name: 'Weight Gurus', family: 'vendor8A' },
    { match: ['body connect'], name: 'Body Connect', family: 'vendor8A' },
    { match: ['es-cs20m', 'es-32md', '113360_', 'es-26bb'], name: 'Renpho ES-CS20M / ES-26BB / FitIndex', family: 'vendor1A10' },
    { match: ['ihealth', 'hs3'], name: 'iHealth HS3', family: 'unknown' },
    { match: ['vscale'], name: 'Exingtech Y1', family: 'unknown' },
    { match: ['afu'], name: 'AFU B1', family: 'unknown' },
    { match: ['chronocloud', 'ryfit'], name: 'RyFit', family: 'unknown' },
    { match: ['realme'], name: 'Realme Smart Scale', family: 'unknown' },
    { match: ['keep s3'], name: 'Keep S3', family: 'unknown' },
    { match: ['omron', 'hbf-'], name: 'Omron body composition scale', family: 'unknown', note: 'Omron uses a proprietary record protocol; model name determines the layout.' },
    { match: ['body fat-b2'], name: 'Ebelter Body Fat B2', family: 'unknown' },
  ];

  // How many of openScale's device handlers fall in each family. This is the honest
  // answer to "will scales give me standard data?" — measured, not guessed.
  const POPULATION = {
    surveyedHandlers: 65,
    standardProfile: 7,
    broadcastOnly: 11,
    proprietaryGatt: 45,
    unclassified: 2,
    source: 'openScale device handler registry, cloned 2026-09',
  };

  function identify(deviceName, serviceUuids) {
    const name = String(deviceName || '').toLowerCase();
    const result = { name: deviceName || '(no name)', model: null, family: 'unknown', note: null, matchedBy: null };
    if (name) {
      for (const d of DEVICES) {
        if (d.match.some((p) => name.includes(p))) {
          result.model = d.name; result.family = d.family; result.note = d.note || null; result.matchedBy = 'name';
          break;
        }
      }
    }
    const u16s = (serviceUuids || []).map((u) => BCS.uuid16(u)).filter((u) => u !== null);
    result.services = u16s;
    const hasStandard = u16s.includes(0x181b) || u16s.includes(0x181d);
    if (result.family === 'unknown' && u16s.length) {
      for (const u of u16s) {
        if (VENDOR_UUID_FAMILY[u]) { result.family = VENDOR_UUID_FAMILY[u]; result.matchedBy = 'service UUID 0x' + u.toString(16); break; }
      }
      if (result.family === 'unknown' && hasStandard) { result.family = 'standard'; result.matchedBy = 'service UUID 0x181B/0x181D'; }
    }
    result.familyInfo = FAMILIES[result.family];
    result.hasStandardServices = hasStandard;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Xiaomi Mi Scale record decoder (independent implementation of a publicly
  // documented format). Accepts the 10-byte v1 record and the 13-byte v2 record,
  // whether it came from advertisement service data or a GATT characteristic.
  // ---------------------------------------------------------------------------
  function parseMiScaleRecord(input) {
    const b = BCS.toBytes(input);
    const out = { characteristic: 'Xiaomi Mi Scale record', raw: BCS.hex(b), length: b.length, fields: [], values: {}, warnings: [], flagBits: [] };
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const push = (name, offset, size, value, unit, note) => {
      out.fields.push({ name, offset, size, rawHex: BCS.hex(b.slice(offset, offset + size)), value, unit: unit || '', note: note || '' });
      out.values[name] = value;
    };

    if (b.length === 10 || b.length === 9) {
      const ctrl = b[0];
      const isLbs = !!(ctrl & 0x01), isCatty = !!(ctrl & 0x10), stable = !!(ctrl & 0x20), removed = !!(ctrl & 0x80);
      out.variant = 'Mi Scale v1 (10-byte record)';
      out.flagBits = [
        { bit: 0, name: 'Unit is lbs', set: isLbs }, { bit: 4, name: 'Unit is catty/jin', set: isCatty },
        { bit: 5, name: 'Weight stabilised', set: stable }, { bit: 7, name: 'Weight removed', set: removed },
      ];
      const raw = dv.getUint16(1, true);
      const divisor = (isLbs || isCatty) ? 100 : 200;
      push('Control byte', 0, 1, '0x' + ctrl.toString(16).padStart(2, '0'), '', (stable ? 'stabilised' : 'still settling') + (removed ? ', user stepped off' : ''));
      push('Weight', 1, 2, Math.round((raw / divisor) * 1000) / 1000, isLbs ? 'lb' : isCatty ? 'catty' : 'kg', `raw ${raw} / ${divisor}`);
      if (b.length >= 9) {
        const year = dv.getUint16(3, true);
        const iso = `${year}-${String(b[5]).padStart(2, '0')}-${String(b[6]).padStart(2, '0')}T${String(b[7]).padStart(2, '0')}:${String(b[8]).padStart(2, '0')}:${String(b[9] || 0).padStart(2, '0')}`;
        push('Time Stamp', 3, b.length >= 10 ? 7 : 6, iso, '');
      }
      if (!stable) out.warnings.push('Weight is not stabilised yet — this is a live reading, not the final measurement.');
      if (removed) out.warnings.push('"Weight removed" bit set — the user has stepped off.');
      return out;
    }

    if (b.length === 13) {
      const unit = b[0], status = b[1];
      const isLbs = !!(unit & 0x01), isCatty = !!(unit & 0x10);
      const impedanceStable = !!(status & 0x02), stable = !!(status & 0x20), removed = !!(status & 0x80);
      out.variant = 'Mi Body Composition Scale v2 (13-byte record)';
      out.flagBits = [
        { bit: 0, name: 'Unit is lbs', set: isLbs }, { bit: 4, name: 'Unit is catty/jin', set: isCatty },
        { bit: 1, name: 'Impedance stabilised', set: impedanceStable },
        { bit: 5, name: 'Weight stabilised', set: stable }, { bit: 7, name: 'Weight removed', set: removed },
      ];
      push('Unit byte', 0, 1, '0x' + unit.toString(16).padStart(2, '0'), '', isLbs ? 'lbs' : isCatty ? 'catty' : 'kg');
      push('Status byte', 1, 1, '0x' + status.toString(16).padStart(2, '0'), '', (stable ? 'weight stable' : 'weight settling') + (impedanceStable ? ', impedance stable' : ''));
      const year = dv.getUint16(2, true);
      push('Time Stamp', 2, 7, `${year}-${String(b[4]).padStart(2, '0')}-${String(b[5]).padStart(2, '0')}T${String(b[6]).padStart(2, '0')}:${String(b[7]).padStart(2, '0')}:${String(b[8]).padStart(2, '0')}`, '');
      const imp = dv.getUint16(9, true);
      push('Impedance', 9, 2, imp === 0xffff ? null : imp, 'Ω', imp === 0xffff ? 'not measured' : '');
      const raw = dv.getUint16(11, true);
      const divisor = (isLbs || isCatty) ? 100 : 200;
      push('Weight', 11, 2, Math.round((raw / divisor) * 1000) / 1000, isLbs ? 'lb' : isCatty ? 'catty' : 'kg', `raw ${raw} / ${divisor}`);
      if (!stable) out.warnings.push('Weight not stabilised yet — live reading.');
      if (!impedanceStable) out.warnings.push('Impedance not stabilised — body composition values derived from this would be wrong.');
      out.warnings.push('Mi Scale sends only weight and impedance. Body fat, muscle and water are computed by the Mi Fit app, not by the scale.');
      return out;
    }

    out.warnings.push(`Not a known Mi Scale record length (got ${b.length}, expected 10 or 13).`);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Heuristic frame scanner for unknown proprietary protocols. Slides a 16-bit
  // window over the frame in both byte orders with the divisors vendors actually
  // use, and reports offsets whose value lands in a plausible human range.
  // This is a reverse-engineering aid, not a decoder: it guesses.
  // ---------------------------------------------------------------------------
  function guessFields(input, opts) {
    const b = BCS.toBytes(input);
    const o = opts || {};
    const minKg = o.minKg || 20, maxKg = o.maxKg || 250;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const guesses = [];
    for (let i = 0; i + 2 <= b.length; i++) {
      for (const le of [true, false]) {
        const raw = dv.getUint16(i, le);
        for (const div of [10, 100, 200]) {
          const kg = raw / div;
          if (kg >= minKg && kg <= maxKg) {
            guesses.push({ offset: i, endian: le ? 'LE' : 'BE', raw, divisor: div, asKg: Math.round(kg * 100) / 100, kind: 'weight?' });
          }
        }
        // impedance is typically 200–1200 Ω raw, or tenths of an ohm
        if (raw >= 200 && raw <= 1200) guesses.push({ offset: i, endian: le ? 'LE' : 'BE', raw, divisor: 1, asKg: null, kind: 'impedance? (' + raw + ' Ω)' });
      }
    }
    // percentages in tenths (body fat 3–70 %)
    for (let i = 0; i + 2 <= b.length; i++) {
      for (const le of [true, false]) {
        const raw = dv.getUint16(i, le);
        const pct = raw / 10;
        if (pct >= 3 && pct <= 70) guesses.push({ offset: i, endian: le ? 'LE' : 'BE', raw, divisor: 10, asKg: null, kind: 'percentage? (' + pct + ' %)' });
      }
    }
    return { length: b.length, hex: BCS.hex(b), guesses };
  }

  function optionalServices() { return STANDARD_SERVICES.concat(VENDOR_SERVICES); }

  return {
    FAMILIES, DEVICES, POPULATION, STANDARD_SERVICES, VENDOR_SERVICES, VENDOR_UUID_FAMILY,
    identify, parseMiScaleRecord, guessFields, optionalServices,
  };
});
