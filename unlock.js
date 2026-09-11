/*
 * 手机无线音效话筒 - 兑换码解锁模块
 * =====================================================
 * 设计原则：
 *   1. 不上传、不存储任何录音音频（本模块只处理兑换码文本）。
 *   2. 默认纯离线：校验完全在本地完成，零联网、零 token。
 *   3. 可选联网校验：如果配置了 REMOTE_API，会先请求一次服务器；
 *      服务器不可达 / 超时 / 未配置 -> 自动回落本地校验，不影响使用。
 *   4. 校验成功后写入 localStorage，永久解锁；此后断网也能用全部高级音效。
 *
 * 发码方式：见同目录 make_codes.py（老板自己生成，随时换码表）
 */

(function (global) {
  'use strict';

  /* ==================================================================
   * 配置区（老板按需改这里）
   * ================================================================== */

  // （1）联网校验接口：留空字符串 = 纯离线校验（推荐，零成本、零延迟）
  //     如果以后想加服务器核销（防止一码多用），填上接口地址即可，
  //     接口约定：POST { code } -> { ok: true/false }
  var REMOTE_API = '';

  // （2）联网校验超时（毫秒）——超时立即回落本地校验，避免卡住用户
  var REMOTE_TIMEOUT = 2500;

  // （3）本地码表（哈希前 8 位）。改码表请用 make_codes.py 重新生成。
  //     这里存的是码的 SHA-256 前 8 位小写十六进制，不存明文。
  var CODE_HASHES = [
    "631e8626",
    "b9531e25",
    "f3169da5",
    "88dc75a8",
    "db201feb",
    "00a5afd0",
    "42a6be27",
    "38174ddf",
    "4eac087b",
    "8a0c73fc",
    "254eff5a",
    "a63f8777",
    "bfc6d007",
    "2b066ae9",
    "f18c8147",
    "ff472ea9",
    "ca10ad81",
    "aadba58e",
    "d595a593",
    "06b427b2",
    "b715a04a",
    "3e90eb95",
    "019c6e4a",
    "31dbd273",
    "9f9aa41f",
    "d833c230",
    "eb25d361",
    "584d9f33",
    "f3c1731e",
    "4e9a0926",

    // === 由 make_codes.py 生成后粘贴到这里 ===
  ];

  // （4）万能码哈希（自己测试用；留空 = 关闭）
  var MASTER_HASHES = [
    // === 由 make_codes.py 生成 ===
  ];

  // （5）解锁状态在 localStorage 里的键名
  var STORAGE_KEY = 'micfx_unlocked_v1';

  /* ==================================================================
   * 工具：SHA-256（优先用浏览器原生 crypto.subtle，失败则用内置兜底）
   * ================================================================== */

  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) {
      s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    }
    return s;
  }

  // 纯 JS SHA-256 兜底（部分老安卓 WebView 在非 HTTPS 下没有 crypto.subtle）
  function sha256Fallback(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bytes = [];
    for (var i = 0; i < ascii.length; i++) {
      var c = ascii.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) { bytes.push(192 | (c >> 6), 128 | (c & 63)); }
      else { bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
    }
    var l = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bits = l * 8;
    bytes.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);

    for (var off = 0; off < bytes.length; off += 64) {
      var w = [];
      for (var j = 0; j < 16; j++) {
        w[j] = (bytes[off + j * 4] << 24) | (bytes[off + j * 4 + 1] << 16) |
               (bytes[off + j * 4 + 2] << 8) | bytes[off + j * 4 + 3];
      }
      for (var t = 16; t < 64; t++) {
        var s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t2 = 0; t2 < 64; t2++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K[t2] + w[t2]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        var mj = (a & b) ^ (a & cc) ^ (b & cc);
        var temp2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = cc; cc = b; b = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = '';
    for (var k = 0; k < 8; k++) {
      var v = H[k] >>> 0;
      out += ('00000000' + v.toString(16)).slice(-8);
    }
    return out;
  }

  function hash8(str) {
    // crypto.subtle 只在安全上下文（https / localhost）可用；不可用时直接兜底
    if (global.crypto && global.crypto.subtle && global.isSecureContext) {
      try {
        var enc = new TextEncoder().encode(str);
        return global.crypto.subtle.digest('SHA-256', enc).then(function (buf) {
          return toHex(buf).slice(0, 8);
        }).catch(function () { return sha256Fallback(str).slice(0, 8); });
      } catch (e) { /* 落到兜底 */ }
    }
    return Promise.resolve(sha256Fallback(str).slice(0, 8));
  }

  /* ==================================================================
   * 规范化用户输入：去空格、去横线、统一大写
   * ================================================================== */

  function normalize(raw) {
    return String(raw || '')
      .replace(/[\s\-_—－]/g, '')
      .toUpperCase();
  }

  /* ==================================================================
   * 本地存储的安全访问层
   * 说明：部分浏览器在「无痕模式 / 禁用 Cookie / 存储配额满」时，
   *       访问 localStorage 本身就会抛异常。这里统一包一层，
   *       拿不到存储时降级为内存态（当次会话仍可用，只是关掉页面要重输）。
   * ================================================================== */

  var _memoryStore = null;

  function _getStore() {
    // 优先 window.localStorage，其次全局，最后内存兜底
    try {
      if (global.localStorage) {
        // 触碰一次，确认真的能用（有些环境读取也抛异常）
        global.localStorage.getItem(STORAGE_KEY);
        return global.localStorage;
      }
    } catch (e) {}
    if (!_memoryStore) {
      var mem = {};
      _memoryStore = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
    return _memoryStore;
  }

  /* ==================================================================
   * 主对象
   * ================================================================== */

  var Unlock = {
    STORAGE_KEY: STORAGE_KEY,
    CODE_HASHES: CODE_HASHES,

    // 是否已解锁（读本地存储）
    isUnlocked: function () {
      try {
        var v = _getStore().getItem(STORAGE_KEY);
        if (!v) return false;
        var obj = JSON.parse(v);
        return !!(obj && obj.ok);
      } catch (e) { return false; }
    },

    // 写入解锁状态
    _persist: function (code) {
      try {
        _getStore().setItem(STORAGE_KEY, JSON.stringify({
          ok: true,
          code: normalize(code).slice(0, 4) + '****',   // 只留前 4 位用于展示，不存完整码
          at: Date.now()
        }));
      } catch (e) {}
    },

    // 清除解锁（调试用）
    clear: function () {
      try { _getStore().removeItem(STORAGE_KEY); } catch (e) {}
    },

    /* --------------------------------------------------------------
     * 校验兑换码
     * 返回 Promise<{ ok:boolean, reason:string, source:string }>
     *   reason: '' | 'empty' | 'invalid' | 'format' | 'network'
     *   source: 'remote' | 'local'
     * -------------------------------------------------------------- */
    verify: function (rawCode) {
      var code = normalize(rawCode);
      if (!code) return Promise.resolve({ ok: false, reason: 'empty', source: 'local' });
      // 只挡「明显没输完」的输入（1~2 位）。
      // 不设更高下限：万一日后改成短码，也不会被这里误杀。
      if (code.length < 3) return Promise.resolve({ ok: false, reason: 'format', source: 'local' });

      // 先走联网校验（只有配置了 REMOTE_API 才走）
      var remotePromise = Promise.resolve(null);
      if (REMOTE_API) {
        remotePromise = this._remoteVerify(code);
      }

      return remotePromise.then(function (remoteResult) {
        if (remoteResult && remoteResult.ok === true) {
          return { ok: true, reason: '', source: 'remote' };
        }
        // 服务器明确说无效 -> 不回落（防止有人拿本地码表暴力试探）
        if (remoteResult && remoteResult.ok === false && remoteResult.authoritative) {
          return { ok: false, reason: 'invalid', source: 'remote' };
        }
        // 服务器不可达/未配置 -> 本地校验
        return hash8(code).then(function (h) {
          if (CODE_HASHES.indexOf(h) >= 0) return { ok: true, reason: '', source: 'local' };
          if (MASTER_HASHES.indexOf(h) >= 0) return { ok: true, reason: '', source: 'local' };
          return { ok: false, reason: 'invalid', source: 'local' };
        });
      });
    },

    _remoteVerify: function (code) {
      var timeout = new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: false, authoritative: false, reason: 'timeout' }); }, REMOTE_TIMEOUT);
      });
      var req = fetch(REMOTE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      }).then(function (r) {
        if (!r.ok) return { ok: false, authoritative: false, reason: 'http' };
        return r.json().then(function (j) {
          return { ok: !!j.ok, authoritative: true };
        });
      }).catch(function () {
        return { ok: false, authoritative: false, reason: 'network' };
      });
      return Promise.race([req, timeout]);
    },

    /* --------------------------------------------------------------
     * 校验 + 解锁（供 UI 直接调用）
     * -------------------------------------------------------------- */
    redeem: function (rawCode) {
      var self = this;
      return this.verify(rawCode).then(function (r) {
        if (r.ok) { self._persist(rawCode); }
        return r;
      });
    }
  };

  global.MicUnlock = Unlock;

})(window);
