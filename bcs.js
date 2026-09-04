/*
 * bcs.js — parsers for the Bluetooth SIG Body Composition Service (BCS, 0x181B)
 * and Weight Scale Service (WSS, 0x181D).
 *
 * Works in the browser (window.BCS) and in Node (module.exports). No dependencies.
 *
 * Sources:
 *   BCS v1.0   (2014-10-21) and BCS v1.0.1 (2024-06-11), Bluetooth SIG.
 *   Field formats/units come from the GATT Specification Supplement / Assigned
 *   Numbers ("Body Composition Measurement" 0x2A9C, "Body Composition Feature"
 *   0x2A9B, "Weight Measurement" 0x2A9D, "Weight Scale Feature" 0x2A9E).
 *
 * The two service versions share an identical byte layout for 0x2A9C. The
 * `version` option only changes labelling and the version-specific behaviour
 * notes returned alongside the parse result.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BCS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UUID = {
    BODY_COMPOSITION_SERVICE: 0x181b,
    BODY_COMPOSITION_FEATURE: 0x2a9b,
    BODY_COMPOSITION_MEASUREMENT: 0x2a9c,
    WEIGHT_SCALE_SERVICE: 0x181d,
    WEIGHT_MEASUREMENT: 0x2a9d,
    WEIGHT_SCALE_FEATURE: 0x2a9e,
    USER_DATA_SERVICE: 0x181c,
    CURRENT_TIME_SERVICE: 0x1805,
    DEVICE_INFORMATION_SERVICE: 0x180a,
    BATTERY_SERVICE: 0x180f,
    GENERIC_ACCESS: 0x1800,
    GENERIC_ATTRIBUTE: 0x1801,
  };

  const NAMES = {
    0x1800: 'Generic Access', 0x1801: 'Generic Attribute', 0x1805: 'Current Time Service',
    0x180a: 'Device Information', 0x180f: 'Battery Service', 0x181b: 'Body Composition Service',
    0x181c: 'User Data Service', 0x181d: 'Weight Scale Service', 0x1812: 'Human Interface Device',
    0x2a00: 'Device Name', 0x2a01: 'Appearance', 0x2a05: 'Service Changed', 0x2a19: 'Battery Level',
    0x2a23: 'System ID', 0x2a24: 'Model Number String', 0x2a25: 'Serial Number String',
    0x2a26: 'Firmware Revision String', 0x2a27: 'Hardware Revision String',
    0x2a28: 'Software Revision String', 0x2a29: 'Manufacturer Name String', 0x2a2b: 'Current Time',
    0x2a80: 'Age', 0x2a85: 'Date of Birth', 0x2a8c: 'Gender', 0x2a8e: 'Height', 0x2a98: 'Weight',
    0x2a99: 'Database Change Increment', 0x2a9a: 'User Index',
    0x2a9b: 'Body Composition Feature', 0x2a9c: 'Body Composition Measurement',
    0x2a9d: 'Weight Measurement', 0x2a9e: 'Weight Scale Feature', 0x2a9f: 'User Control Point',
    0x2901: 'Characteristic User Description', 0x2902: 'Client Characteristic Configuration',
    0x2904: 'Characteristic Presentation Format',
    0xfe95: 'Xiaomi Inc. (member service)', 0xffe0: 'Vendor 0xFFE0 (common in cheap scales)',
    0xfff0: 'Vendor 0xFFF0 (common in cheap scales)', 0xffb0: 'Vendor 0xFFB0', 0xfee0: 'Vendor 0xFEE0',
    0xfee7: 'Vendor 0xFEE7 (Tencent/WeChat)', 0xfea0: 'Vendor 0xFEA0',
  };

  const VERSIONS = {
    '1.0': {
      id: '1.0',
      label: 'BCS v1.0 (adopted 2014-10-21)',
      coreSpec: 'Bluetooth Core 4.0 or later',
      featureIndicate: false,
      notes: [
        'Body Composition Feature (0x2A9B): Read only.',
        'Body Composition Measurement (0x2A9C): Indicate only (no Notify property in the spec).',
        'Byte layout of 0x2A9C: Flags(uint16) + Body Fat %(uint16) + optional fields — identical to v1.0.1.',
      ],
    },
    '1.0.1': {
      id: '1.0.1',
      label: 'BCS v1.0.1 (adopted 2024-06-11, errata 16256/16257/18743/18955/23312/22309)',
      coreSpec: 'Bluetooth Core 4.2 or later',
      featureIndicate: true,
      notes: [
        'Body Composition Feature (0x2A9B): Read, plus optional Indicate (C.1: if the device supports bonding and the feature value can change over its lifetime).',
        'Body Composition Measurement (0x2A9C): Indicate only — unchanged.',
        'Byte layout of 0x2A9C: identical to v1.0. The errata changed references, the SDP record for BR/EDR and the Feature-indication rule only.',
      ],
    },
  };

  // Resolution tables shared by Body Composition Feature (bits 11–14 / 15–17)
  // and Weight Scale Feature (bits 3–6 / 7–9).
  const MASS_RESOLUTION = {
    0: 'Not specified', 1: '0.5 kg or 1 lb', 2: '0.2 kg or 0.5 lb', 3: '0.1 kg or 0.2 lb',
    4: '0.05 kg or 0.1 lb', 5: '0.02 kg or 0.05 lb', 6: '0.01 kg or 0.02 lb', 7: '0.005 kg or 0.01 lb',
  };
  const HEIGHT_RESOLUTION = {
    0: 'Not specified', 1: '0.01 m or 1 in', 2: '0.005 m or 0.5 in', 3: '0.001 m or 0.1 in',
  };

  // ---------- byte helpers ----------
  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof DataView !== 'undefined' && input instanceof DataView) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (typeof input === 'string') return hexToBytes(input);
    throw new TypeError('Unsupported byte input: ' + Object.prototype.toString.call(input));
  }

  function hexToBytes(str) {
    const clean = String(str).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2 !== 0) throw new Error('Hex string has an odd number of digits: ' + str);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function hex(bytes, sep) {
    const b = toBytes(bytes);
    const s = sep === undefined ? ' ' : sep;
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(s);
  }

  function uuid16(uuid) {
    // Accept a number, '0x2a9c', '2a9c', or a full 128-bit Bluetooth base UUID.
    if (typeof uuid === 'number') return uuid & 0xffff;
    const s = String(uuid).toLowerCase().trim();
    const m = s.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
    if (m) return parseInt(m[1], 16);
    const m2 = s.match(/^(?:0x)?([0-9a-f]{1,4})$/);
    if (m2) return parseInt(m2[1], 16);
    return null; // vendor 128-bit UUID
  }

  function nameOf(uuid) {
    const u = uuid16(uuid);
    if (u === null) return 'vendor-specific';
    return NAMES[u] || ('0x' + u.toString(16).padStart(4, '0').toUpperCase());
  }

  function round(v, d) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

  // ---------- Date Time characteristic (7 bytes) ----------
  function parseDateTime(bytes, offset) {
    const b = toBytes(bytes);
    const o = offset || 0;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const year = dv.getUint16(o, true);
    const month = b[o + 2], day = b[o + 3], hours = b[o + 4], minutes = b[o + 5], seconds = b[o + 6];
    const unknownDate = year === 0 || month === 0 || day === 0;
    const pad = (n) => String(n).padStart(2, '0');
    const iso = unknownDate ? null : `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    const warnings = [];
    if (unknownDate) warnings.push('Time Stamp has a 0 (unknown) year/month/day — BCS forbids this value for this service.');
    if (month > 12 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) warnings.push('Time Stamp has an out-of-range component.');
    return { year, month, day, hours, minutes, seconds, iso, warnings };
  }

  // ---------- generic field reader ----------
  function makeReader(b, out) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 0;
    const r = {
      get offset() { return off; },
      remaining() { return b.length - off; },
      need(n, name) {
        if (out.truncated) return false; // stop after the first truncation; later fields are meaningless
        if (off + n > b.length) {
          out.truncated = true;
          out.warnings.push(`Packet truncated: ${name} needs ${n} byte(s) at offset ${off} but only ${b.length - off} remain; parsing stopped.`);
          return false;
        }
        return true;
      },
      u8(name) { const v = b[off]; off += 1; return v; },
      u16(name) { const v = dv.getUint16(off, true); off += 2; return v; },
      u32(name) { const v = dv.getUint32(off, true); off += 4; return v; },
      slice(n) { const s = b.slice(off, off + n); off += n; return s; },
    };
    return r;
  }

  function pushField(out, r, name, size, fn) {
    if (out.truncated || !r.need(size, name)) return null;
    const start = r.offset;
    const f = { name, offset: start, size, rawHex: hex(toBytes(out._bytes).slice(start, start + size)) };
    const res = fn(f);
    Object.assign(f, res);
    out.fields.push(f);
    if (f.value !== undefined) out.values[f.key || name] = f.value;
    return f;
  }

  // ---------- 0x2A9C Body Composition Measurement ----------
  const BCM_FLAG_NAMES = [
    'Measurement Units (0 = SI kg/m, 1 = Imperial lb/in)',
    'Time Stamp Present',
    'User ID Present',
    'Basal Metabolism Present',
    'Muscle Percentage Present',
    'Muscle Mass Present',
    'Fat Free Mass Present',
    'Soft Lean Mass Present',
    'Body Water Mass Present',
    'Impedance Present',
    'Weight Present',
    'Height Present',
    'Multiple Packet Measurement',
    'RFU (bit 13)', 'RFU (bit 14)', 'RFU (bit 15)',
  ];

  function parseBodyCompositionMeasurement(input, opts) {
    const version = (opts && opts.version) || '1.0.1';
    const b = toBytes(input);
    const out = {
      characteristic: 'Body Composition Measurement', uuid: 0x2a9c, version,
      spec: VERSIONS[version] ? VERSIONS[version].label : 'unknown version ' + version,
      raw: hex(b), length: b.length,
      flags: null, flagBits: [], fields: [], values: {}, warnings: [],
      units: null, multiplePacket: false, measurementUnsuccessful: false, _bytes: b,
    };
    if (!VERSIONS[version]) out.warnings.push('Unknown spec version "' + version + '"; parsed with the v1.0/v1.0.1 layout.');
    const r = makeReader(b, out);
    if (!r.need(2, 'Flags')) return finish(out);
    const flags = r.u16('Flags');
    out.flags = flags;
    out.flagsHex = '0x' + flags.toString(16).padStart(4, '0');
    for (let bit = 0; bit < 16; bit++) {
      out.flagBits.push({ bit, name: BCM_FLAG_NAMES[bit], set: !!(flags & (1 << bit)) });
    }
    const imperial = !!(flags & 0x0001);
    out.units = imperial ? 'imperial' : 'SI';
    const massUnit = imperial ? 'lb' : 'kg';
    const massRes = imperial ? 0.01 : 0.005;
    const heightUnit = imperial ? 'in' : 'm';
    const heightRes = imperial ? 0.1 : 0.001;
    out.multiplePacket = !!(flags & (1 << 12));
    if (flags & 0xe000) out.warnings.push('Reserved-for-future-use flag bits 13–15 are set (' + out.flagsHex + '); the device is not strictly spec-compliant or this is not a BCS packet.');

    const massField = (key, label) => (f) => {
      const rawv = r.u16(label);
      return { key, raw: rawv, value: round(rawv * massRes, 3), unit: massUnit, resolution: massRes + ' ' + massUnit };
    };

    pushField(out, r, 'Body Fat Percentage', 2, (f) => {
      const rawv = r.u16('Body Fat Percentage');
      if (rawv === 0xffff) {
        out.measurementUnsuccessful = true;
        return { key: 'bodyFatPercent', raw: rawv, value: null, unit: '%', note: '0xFFFF = Measurement Unsuccessful' };
      }
      return { key: 'bodyFatPercent', raw: rawv, value: round(rawv * 0.1, 1), unit: '%', resolution: '0.1 %' };
    });
    if (flags & (1 << 1)) pushField(out, r, 'Time Stamp', 7, (f) => {
      const dt = parseDateTime(b, r.offset);
      r.slice(7);
      dt.warnings.forEach((w) => out.warnings.push(w));
      return { key: 'timeStamp', value: dt.iso, unit: '', note: dt.iso ? '' : 'unknown date', detail: dt };
    });
    if (flags & (1 << 2)) pushField(out, r, 'User ID', 1, (f) => {
      const v = r.u8('User ID');
      return { key: 'userId', raw: v, value: v, unit: '', note: v === 0xff ? '0xFF = unknown user (guest)' : '' };
    });
    if (flags & (1 << 3)) pushField(out, r, 'Basal Metabolism', 2, (f) => {
      const v = r.u16('Basal Metabolism');
      return { key: 'basalMetabolismKJ', raw: v, value: v, unit: 'kJ', resolution: '1 kJ', note: '≈ ' + round(v / 4.184, 0) + ' kcal' };
    });
    if (flags & (1 << 4)) pushField(out, r, 'Muscle Percentage', 2, (f) => {
      const v = r.u16('Muscle Percentage');
      return { key: 'musclePercent', raw: v, value: round(v * 0.1, 1), unit: '%', resolution: '0.1 %' };
    });
    if (flags & (1 << 5)) pushField(out, r, 'Muscle Mass', 2, massField('muscleMass', 'Muscle Mass'));
    if (flags & (1 << 6)) pushField(out, r, 'Fat Free Mass', 2, massField('fatFreeMass', 'Fat Free Mass'));
    if (flags & (1 << 7)) pushField(out, r, 'Soft Lean Mass', 2, massField('softLeanMass', 'Soft Lean Mass'));
    if (flags & (1 << 8)) pushField(out, r, 'Body Water Mass', 2, massField('bodyWaterMass', 'Body Water Mass'));
    if (flags & (1 << 9)) pushField(out, r, 'Impedance', 2, (f) => {
      const v = r.u16('Impedance');
      return { key: 'impedanceOhm', raw: v, value: round(v * 0.1, 1), unit: 'Ω', resolution: '0.1 Ω' };
    });
    if (flags & (1 << 10)) pushField(out, r, 'Weight', 2, massField('weight', 'Weight'));
    if (flags & (1 << 11)) pushField(out, r, 'Height', 2, (f) => {
      const v = r.u16('Height');
      return { key: 'height', raw: v, value: round(v * heightRes, 3), unit: heightUnit, resolution: heightRes + ' ' + heightUnit };
    });

    // Bits 3-11 are every optional field other than Time Stamp (1) and User ID (2).
    if (out.measurementUnsuccessful && (flags & 0x0ff8)) {
      out.warnings.push('Body Fat Percentage is 0xFFFF (unsuccessful) but optional fields other than Time Stamp / User ID are present — the spec says they shall be disabled in that case.');
    }
    if (out.multiplePacket) {
      out.notes = out.notes || [];
      out.notes.push('Multiple Packet Measurement bit set: this measurement is split across two consecutive indications; the continuation packet repeats Flags + Body Fat % and carries the remaining optional fields (never Time Stamp or User ID).');
    }
    return finish(out, r);
  }

  // ---------- 0x2A9D Weight Measurement (Weight Scale Service) ----------
  function parseWeightMeasurement(input, opts) {
    const b = toBytes(input);
    const out = {
      characteristic: 'Weight Measurement', uuid: 0x2a9d, version: (opts && opts.version) || 'WSS 1.0',
      raw: hex(b), length: b.length, flags: null, flagBits: [], fields: [], values: {}, warnings: [], units: null,
      measurementUnsuccessful: false, _bytes: b,
    };
    const r = makeReader(b, out);
    if (!r.need(1, 'Flags')) return finish(out);
    const flags = r.u8('Flags');
    out.flags = flags;
    out.flagsHex = '0x' + flags.toString(16).padStart(2, '0');
    const names = ['Measurement Units (0 = SI, 1 = Imperial)', 'Time Stamp Present', 'User ID Present', 'BMI and Height Present', 'RFU (bit 4)', 'RFU (bit 5)', 'RFU (bit 6)', 'RFU (bit 7)'];
    for (let bit = 0; bit < 8; bit++) out.flagBits.push({ bit, name: names[bit], set: !!(flags & (1 << bit)) });
    const imperial = !!(flags & 1);
    out.units = imperial ? 'imperial' : 'SI';
    if (flags & 0xf0) out.warnings.push('Reserved flag bits 4–7 are set (' + out.flagsHex + ').');
    const massUnit = imperial ? 'lb' : 'kg', massRes = imperial ? 0.01 : 0.005;
    const heightUnit = imperial ? 'in' : 'm', heightRes = imperial ? 0.1 : 0.001;
    pushField(out, r, 'Weight', 2, (f) => {
      const v = r.u16('Weight');
      if (v === 0xffff) { out.measurementUnsuccessful = true; return { key: 'weight', raw: v, value: null, unit: massUnit, note: '0xFFFF = Measurement Unsuccessful' }; }
      return { key: 'weight', raw: v, value: round(v * massRes, 3), unit: massUnit, resolution: massRes + ' ' + massUnit };
    });
    if (flags & (1 << 1)) pushField(out, r, 'Time Stamp', 7, (f) => {
      const dt = parseDateTime(b, r.offset); r.slice(7);
      dt.warnings.forEach((w) => out.warnings.push(w));
      return { key: 'timeStamp', value: dt.iso, unit: '', detail: dt };
    });
    if (flags & (1 << 2)) pushField(out, r, 'User ID', 1, (f) => {
      const v = r.u8('User ID');
      return { key: 'userId', raw: v, value: v, unit: '', note: v === 0xff ? '0xFF = unknown user' : '' };
    });
    if (flags & (1 << 3)) {
      pushField(out, r, 'BMI', 2, (f) => { const v = r.u16('BMI'); return { key: 'bmi', raw: v, value: round(v * 0.1, 1), unit: 'kg/m²', resolution: '0.1' }; });
      pushField(out, r, 'Height', 2, (f) => { const v = r.u16('Height'); return { key: 'height', raw: v, value: round(v * heightRes, 3), unit: heightUnit, resolution: heightRes + ' ' + heightUnit }; });
    }
    return finish(out, r);
  }

  // ---------- 0x2A9B Body Composition Feature ----------
  function parseBodyCompositionFeature(input) {
    const b = toBytes(input);
    const out = { characteristic: 'Body Composition Feature', uuid: 0x2a9b, raw: hex(b), length: b.length, flagBits: [], fields: [], values: {}, warnings: [], _bytes: b };
    const r = makeReader(b, out);
    if (!r.need(4, 'Feature (uint32)')) return finish(out);
    const v = r.u32('Feature');
    out.flags = v; out.flagsHex = '0x' + v.toString(16).padStart(8, '0');
    const bits = ['Time Stamp Supported', 'Multiple Users Supported', 'Basal Metabolism Supported', 'Muscle Percentage Supported',
      'Muscle Mass Supported', 'Fat Free Mass Supported', 'Soft Lean Mass Supported', 'Body Water Mass Supported',
      'Impedance Supported', 'Weight Supported', 'Height Supported'];
    bits.forEach((name, bit) => { const set = !!(v & (1 << bit)); out.flagBits.push({ bit, name, set }); out.values[name] = set; });
    const massRes = (v >>> 11) & 0x0f, heightRes = (v >>> 15) & 0x07;
    out.values['Mass Measurement Resolution (bits 11–14)'] = massRes + ' → ' + (MASS_RESOLUTION[massRes] || 'Reserved');
    out.values['Height Measurement Resolution (bits 15–17)'] = heightRes + ' → ' + (HEIGHT_RESOLUTION[heightRes] || 'Reserved');
    if (v >>> 18) out.warnings.push('RFU bits 18–31 are non-zero.');
    return finish(out, r);
  }

  // ---------- 0x2A9E Weight Scale Feature ----------
  function parseWeightScaleFeature(input) {
    const b = toBytes(input);
    const out = { characteristic: 'Weight Scale Feature', uuid: 0x2a9e, raw: hex(b), length: b.length, flagBits: [], fields: [], values: {}, warnings: [], _bytes: b };
    const r = makeReader(b, out);
    if (!r.need(4, 'Feature (uint32)')) return finish(out);
    const v = r.u32('Feature');
    out.flags = v; out.flagsHex = '0x' + v.toString(16).padStart(8, '0');
    ['Time Stamp Supported', 'Multiple Users Supported', 'BMI Supported'].forEach((name, bit) => { const set = !!(v & (1 << bit)); out.flagBits.push({ bit, name, set }); out.values[name] = set; });
    const wRes = (v >>> 3) & 0x0f, hRes = (v >>> 7) & 0x07;
    out.values['Weight Measurement Resolution (bits 3–6)'] = wRes + ' → ' + (MASS_RESOLUTION[wRes] || 'Reserved');
    out.values['Height Measurement Resolution (bits 7–9)'] = hRes + ' → ' + (HEIGHT_RESOLUTION[hRes] || 'Reserved');
    if (v >>> 10) out.warnings.push('RFU bits 10–31 are non-zero.');
    return finish(out, r);
  }

  function finish(out, r) {
    if (r && !out.truncated && r.remaining() > 0) {
      const extra = toBytes(out._bytes).slice(r.offset);
      out.leftover = hex(extra);
      out.warnings.push(`${extra.length} unexpected trailing byte(s) after the last field: ${out.leftover}`);
    }
    delete out._bytes;
    return out;
  }

  // ---------- Multiple-packet merge ----------
  // Given the first packet and its continuation (both with the Multiple Packet
  // bit set), produce a single merged result. Later fields win for duplicates.
  function mergeMultiPacket(first, second) {
    const bitsOf = (p) => (p.flagBits || []).reduce((acc, b) => (b.set ? acc | (1 << b.bit) : acc), 0);
    const unionFlags = bitsOf(first) | bitsOf(second);
    const unionBits = BCM_FLAG_NAMES.map((name, bit) => ({ bit, name, set: !!(unionFlags & (1 << bit)) }));
    const merged = {
      characteristic: first.characteristic, uuid: first.uuid, version: first.version, spec: first.spec,
      raw: first.raw + ' || ' + second.raw, length: first.length + second.length,
      flags: [first.flagsHex, second.flagsHex], flagBits: unionBits, units: first.units,
      measurementUnsuccessful: !!(first.measurementUnsuccessful || second.measurementUnsuccessful),
      fields: first.fields.concat(second.fields.filter((f) => f.name !== 'Body Fat Percentage')),
      values: Object.assign({}, first.values, second.values), warnings: first.warnings.concat(second.warnings),
      multiplePacket: true, merged: true, notes: ['Merged from two consecutive indications (Multiple Packet Measurement).'],
    };
    if (second.fields.some((f) => f.name === 'Time Stamp' || f.name === 'User ID')) merged.warnings.push('Continuation packet contained Time Stamp or User ID, which the spec forbids.');
    // Both packets repeat Body Fat Percentage. If they disagree, these are two different
    // measurements and merging them would silently invent a reading.
    const bf1 = first.values && first.values.bodyFatPercent;
    const bf2 = second.values && second.values.bodyFatPercent;
    if (bf1 !== undefined && bf2 !== undefined && bf1 !== bf2) {
      merged.warnings.push(`Body Fat Percentage differs between the two packets (${bf1} vs ${bf2}) — these are not two halves of one measurement; the merged result is unreliable.`);
      merged.mismatched = true;
    }
    if (first.units !== second.units) merged.warnings.push(`Measurement Units differ between the two packets (${first.units} vs ${second.units}).`);
    return merged;
  }

  // ---------- misc characteristics that scales commonly expose ----------
  function parseSimple(uuid, input) {
    const u = uuid16(uuid);
    const b = toBytes(input);
    const text = () => { try { return new TextDecoder().decode(b); } catch (e) { return Array.from(b, (c) => String.fromCharCode(c)).join(''); } };
    switch (u) {
      case 0x2a00: case 0x2a24: case 0x2a25: case 0x2a26: case 0x2a27: case 0x2a28: case 0x2a29:
        return { characteristic: NAMES[u], uuid: u, raw: hex(b), values: { text: text() }, fields: [], warnings: [] };
      case 0x2a19:
        return { characteristic: 'Battery Level', uuid: u, raw: hex(b), values: { percent: b[0] }, fields: [], warnings: [] };
      case 0x2a2b: {
        if (b.length < 7) return { characteristic: 'Current Time', uuid: u, raw: hex(b), values: {}, fields: [], warnings: ['too short'] };
        const dt = parseDateTime(b, 0);
        return { characteristic: 'Current Time', uuid: u, raw: hex(b), values: { dateTime: dt.iso, dayOfWeek: b[7], fractions256: b[8], adjustReason: b[9] }, fields: [], warnings: dt.warnings };
      }
      case 0x2a01:
        return { characteristic: 'Appearance', uuid: u, raw: hex(b), values: { appearance: b.length >= 2 ? '0x' + (b[0] | (b[1] << 8)).toString(16) : null }, fields: [], warnings: [] };
      default:
        return null;
    }
  }

  // ---------- dispatcher ----------
  function parseByUuid(uuid, input, opts) {
    const u = uuid16(uuid);
    switch (u) {
      case 0x2a9c: return parseBodyCompositionMeasurement(input, opts);
      case 0x2a9d: return parseWeightMeasurement(input, opts);
      case 0x2a9b: return parseBodyCompositionFeature(input);
      case 0x2a9e: return parseWeightScaleFeature(input);
      default: return parseSimple(uuid, input);
    }
  }

  // ---------- sample packets (for testing without hardware) ----------
  const SAMPLES = {
    // SI, all optional fields, 2026-09-04 15:53:00, user 1
    bcmSiFull: 'fe 0f c8 00 ea 07 09 04 0f 35 00 01 40 1f 90 01 58 1b e0 2e 88 2c 40 1f 88 13 98 3a d6 06',
    // Imperial, weight + height + timestamp only
    bcmImperial: '03 0c 2c 01 ea 07 09 04 0f 35 00 9c 40 be 02',
    // Multi-packet pair (bit 12 set on both)
    bcmMultiPart1: '3e 10 c8 00 ea 07 09 04 0f 35 00 01 40 1f 90 01 58 1b',
    bcmMultiPart2: 'c0 1f c8 00 e0 2e 88 2c 40 1f 88 13 98 3a d6 06',
    // Measurement unsuccessful, SI, timestamp + user id
    bcmUnsuccessful: '06 00 ff ff ea 07 09 04 0f 35 00 ff',
    // Weight Scale Service: SI, timestamp, user id, BMI + height
    wsmSi: '0e 98 3a ea 07 09 04 0f 35 00 01 f5 00 d6 06',
    // Body Composition Feature: all fields, mass res 7 (0.005 kg), height res 3 (0.001 m)
    bcfAll: 'ff bf 01 00',
    // Weight Scale Feature: ts, users, BMI, weight res 7, height res 3
    wsfAll: 'bf 01 00 00',
  };

  return {
    UUID, NAMES, VERSIONS, MASS_RESOLUTION, HEIGHT_RESOLUTION, SAMPLES,
    toBytes, hexToBytes, hex, uuid16, nameOf, parseDateTime,
    parseBodyCompositionMeasurement, parseWeightMeasurement, parseBodyCompositionFeature, parseWeightScaleFeature,
    parseSimple, parseByUuid, mergeMultiPacket,
  };
});
