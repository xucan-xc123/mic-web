/*
 * 手机无线音效话筒 - 音准修正 / 人声美化 音频处理核心（唱歌模式）
 * =====================================================
 * 纯前端 DSP 实现，不使用任何 AI 模型、不上传、不存储、零外部依赖。
 *   - 音高检测：YIN 算法（自相关改进版），人声范围 70~1100Hz
 *   - 音准修正：检测偏差 -> 映射到十二平均律最近音 -> 可变延迟线移调
 *   - 人声加厚：短延迟双声部叠加（模拟专业歌手的厚度/宽度）
 *   - 齿音抑制：高频段动态压缩（de-esser）
 *
 * 著作权归属：本项目独立开发
 *
 * 链路（唱歌模式）：
 *   麦克风 -> [降噪门+反馈抑制] -> 低切 -> EQ -> 压缩
 *          -> [人声美化: 音准修正 + 加厚 + 齿音]  <- 本文件
 *          -> 混响 -> 音量 -> 限幅 -> 输出
 */

(function (global) {
  'use strict';

  /* ==================================================================
   * 一、音高工具（十二平均律）
   * ================================================================== */

  var A4 = 440.0;                 // 标准音高
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // 频率 -> MIDI 音号（可为小数，便于算音分偏差）
  function freqToMidi(f) {
    if (f <= 0) return 0;
    return 69 + 12 * Math.log(f / A4) / Math.LN2;
  }

  // MIDI 音号 -> 频率
  function midiToFreq(m) {
    return A4 * Math.pow(2, (m - 69) / 12);
  }

  // 频率 -> 音名（用于 UI 显示，如 "A4" / "C#5"）
  function freqToNoteName(f) {
    if (f <= 0) return '';
    var m = Math.round(freqToMidi(f));
    var name = NOTE_NAMES[((m % 12) + 12) % 12];
    var oct = Math.floor(m / 12) - 1;
    return name + oct;
  }

  var PitchUtil = {
    A4: A4,
    freqToMidi: freqToMidi,
    midiToFreq: midiToFreq,
    freqToNoteName: freqToNoteName
  };

  /* ------------------------------------------------------------------
   * YIN 音高检测（主线程版）
   *
   * 为什么要有这份：AudioWorklet 里的 yinPitch 跑在音频线程，主线程拿不到。
   * 之前 UI 的音高显示用了一段"简化自相关"，它有两个致命毛病：
   *   1) 容易锁到 2 倍周期 -> 八度跳变（220Hz 报成 110Hz，392 报成 196）
   *   2) 对弱周期信号不设阈值 -> 低音（男声 82~150Hz）直接报成 1100Hz
   * 结果就是唱歌时音名乱跳、指针不跟歌走。
   *
   * 这里复用与 worklet 完全相同的 YIN 算法（CMND + 阈值 + 抛物线插值），
   * 保证 UI 显示的和实际修音用的判断是同一个。
   * ------------------------------------------------------------------ */
  function yinPitchMain(buf, sr, tauMin, tauMax, threshold) {
    var N = buf.length;
    var halfN = Math.floor(N / 2);
    if (tauMax >= halfN) tauMax = halfN - 1;
    if (tauMax <= tauMin) return { f: 0, conf: 0 };

    var d = new Float32Array(tauMax + 1);
    var tau, j, sum, diff;

    // 1) 差分函数 d(tau)
    for (tau = tauMin; tau <= tauMax; tau++) {
      sum = 0;
      for (j = 0; j < halfN; j++) {
        diff = buf[j] - buf[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    // 2) 累积均值归一化差分函数（CMND）
    var cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    var running = 0;
    for (tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
    }

    // 3) 找第一个低于阈值的谷（这就是"八度不跳"的关键）
    var bestTau = -1;
    for (tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        bestTau = tau;
        break;
      }
    }
    if (bestTau < 0) {
      var minV = 1e9;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < minV) { minV = cmnd[tau]; bestTau = tau; }
      }
      if (bestTau < 0) return { f: 0, conf: 0 };
    }

    // 4) 抛物线插值细化
    var betterTau = bestTau;
    if (bestTau > tauMin && bestTau < tauMax) {
      var s0 = cmnd[bestTau - 1], s1 = cmnd[bestTau], s2 = cmnd[bestTau + 1];
      var denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = bestTau + (s2 - s0) / denom;
    }
    if (betterTau <= 0) return { f: 0, conf: 0 };

    return { f: sr / betterTau, conf: 1 - cmnd[bestTau] };
  }

  PitchUtil.yinPitch = yinPitchMain;


  /* ==================================================================
   * 二、AudioWorklet：人声美化处理器
   *     （内联源码，避免额外文件与跨域问题）
   * ================================================================== */

  var VOICE_FX_SRC = [
    '// 音高检测（YIN 算法简化实现）',
    'function yinPitch(buf, sr, tauMin, tauMax, threshold) {',
    '  var N = buf.length;',
    '  var halfN = Math.floor(N / 2);',
    '  if (tauMax >= halfN) tauMax = halfN - 1;',
    '  if (tauMax <= tauMin) return { f: 0, conf: 0 };',
    '  var d = new Float32Array(tauMax + 1);',
    '  var tau;',
    '  // 1) 差分函数 d(tau)',
    '  for (tau = tauMin; tau <= tauMax; tau++) {',
    '    var sum = 0;',
    '    for (var j = 0; j < halfN; j++) {',
    '      var diff = buf[j] - buf[j + tau];',
    '      sum += diff * diff;',
    '    }',
    '    d[tau] = sum;',
    '  }',
    '  // 2) 累积均值归一化差分函数',
    '  var cmnd = new Float32Array(tauMax + 1);',
    '  cmnd[0] = 1;',
    '  var running = 0;',
    '  for (tau = 1; tau <= tauMax; tau++) {',
    '    running += d[tau];',
    '    cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;',
    '  }',
    '  // 3) 找第一个低于阈值的谷',
    '  var bestTau = -1;',
    '  for (tau = tauMin; tau <= tauMax; tau++) {',
    '    if (cmnd[tau] < threshold) {',
    '      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;',
    '      bestTau = tau;',
    '      break;',
    '    }',
    '  }',
    '  if (bestTau < 0) {',
    '    // 没找到明显周期：取全局最小（低置信度）',
    '    var minV = 1e9;',
    '    for (tau = tauMin; tau <= tauMax; tau++) {',
    '      if (cmnd[tau] < minV) { minV = cmnd[tau]; bestTau = tau; }',
    '    }',
    '    if (bestTau < 0) return { f: 0, conf: 0 };',
    '  }',
    '  // 4) 抛物线插值细化（提高精度）',
    '  var betterTau = bestTau;',
    '  if (bestTau > tauMin && bestTau < tauMax) {',
    '    var s0 = cmnd[bestTau - 1], s1 = cmnd[bestTau], s2 = cmnd[bestTau + 1];',
    '    var denom = 2 * (2 * s1 - s2 - s0);',
    '    if (denom !== 0) betterTau = bestTau + (s2 - s0) / denom;',
    '  }',
    '  if (betterTau <= 0) return { f: 0, conf: 0 };',
    '  var f = sr / betterTau;',
    '  var conf = 1 - cmnd[bestTau];',
    '  return { f: f, conf: conf };',
    '}',
    '',
    '/* ==================================================================',
    ' * LPC 共振峰保持（formant preservation）',
    ' *',
    ' * 为什么需要：单纯把音高拉高，声带的"音高"变了，但口腔/喉咙的',
    ' *   共振峰（formant）也跟着被拉高 -> 听起来像花栗鼠；拉低 -> 像怪兽。',
    ' *   专业修音（Auto-Tune / Melodyne）都会做 formant 保持。',
    ' *',
    ' * 做法（业界标准、计算量可控）：',
    ' *   1) 对"原始输入"求 LPC 系数（order 16、512 点窗、Hamming、',
    ' *      Levinson-Durbin 递推）—— 得到原始共振峰包络。',
    ' *   2) 用该 LPC 做"分析滤波"把移调后的信号的共振峰包络抹平（谱白化）。',
    ' *   3) 再用同一组 LPC 做"合成滤波"，把原始共振峰包络贴回去。',
    ' *   结果：音高变了，音色（谁在唱）没变。',
    ' * ================================================================== */',
    'var LPC_ORDER = 16;',
    'var LPC_WIN = 512;',
    '',
    '// Hamming 窗 + 自相关',
    'function lpcAutocorr(x, off, n, r) {',
    '  var i, k;',
    '  // 加 Hamming 窗后求自相关',
    '  for (k = 0; k <= LPC_ORDER; k++) {',
    '    var s = 0;',
    '    for (i = 0; i < n - k; i++) {',
    '      var wi = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));',
    '      var wj = 0.54 - 0.46 * Math.cos(2 * Math.PI * (i + k) / (n - 1));',
    '      s += (x[off + i] * wi) * (x[off + i + k] * wj);',
    '    }',
    '    r[k] = s;',
    '  }',
    '  return r;',
    '}',
    '',
    '// Levinson-Durbin 递推：自相关 -> LPC 系数 a[1..order]',
    'function lpcLevinson(r, a, order) {',
    '  var e = r[0];',
    '  if (!(e > 0)) return 0;',
    '  var k, i;',
    '  var tmp = new Float32Array(order + 1);',
    '  for (i = 1; i <= order; i++) a[i] = 0;',
    '  for (k = 1; k <= order; k++) {',
    '    var acc = r[k];',
    '    for (i = 1; i < k; i++) acc -= a[i] * r[k - i];',
    '    var ref = e > 1e-12 ? acc / e : 0;',
    '    if (!(ref > -0.999) || !(ref < 0.999)) ref = 0;   // 防发散',
    '    tmp[k] = ref;',
    '    for (i = 1; i < k; i++) tmp[i] = a[i] - ref * a[k - i];',
    '    for (i = 1; i <= k; i++) a[i] = tmp[i];',
    '    e *= (1 - ref * ref);',
    '    if (e <= 1e-12) break;',
    '  }',
    '  return e;',
    '}',
    '',
    '// 用 LPC 做分析滤波（谱白化）：y[n] = x[n] - sum(a[i]*x[n-i])',
    'function lpcAnalysis(x, off, n, a, out, mem) {',
    '  var i, k;',
    '  for (i = 0; i < n; i++) {',
    '    var acc = x[off + i];',
    '    for (k = 1; k <= LPC_ORDER; k++) {',
    '      var idx = i - k;',
    '      acc -= a[k] * (idx >= 0 ? x[off + idx] : mem[k - 1]);',
    '    }',
    '    out[i] = acc;',
    '  }',
    '  // 保存尾部作为下一帧的记忆',
    '  for (k = 0; k < LPC_ORDER; k++) mem[k] = x[off + n - LPC_ORDER + k];',
    '}',
    '',
    '// 用 LPC 做合成滤波（贴回包络）：y[n] = e[n] + sum(a[i]*y[n-i])',
    'function lpcSynthesis(e, n, a, out, mem) {',
    '  var i, k;',
    '  for (i = 0; i < n; i++) {',
    '    var acc = e[i];',
    '    for (k = 1; k <= LPC_ORDER; k++) {',
    '      var idx = i - k;',
    '      acc += a[k] * (idx >= 0 ? out[idx] : mem[k - 1]);',
    '    }',
    '    out[i] = acc;',
    '  }',
    '  for (k = 0; k < LPC_ORDER; k++) mem[k] = out[n - LPC_ORDER + k];',
    '}',
    '',
    'class VoiceFXProcessor extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var p = (options && options.processorOptions) || {};',
    '    this.correctAmt = p.correctAmt != null ? p.correctAmt : 0;   // 0~1 音准修正强度',
    '    this.thickenAmt = p.thickenAmt != null ? p.thickenAmt : 0;   // 0~1 人声加厚',
    '    this.deEssAmt   = p.deEssAmt   != null ? p.deEssAmt   : 0;   // 0~1 齿音抑制',
    '    this.formantAmt = p.formantAmt != null ? p.formantAmt : 0.85;// 0~1 共振峰保持',
    '    // retune：再调速度。0 = 最慢(最自然)，1 = 最快(电音感)',
    '    // 对应 Auto-Tune 的 Retune Speed；业界经验：慢速自然、快速变电音。',
    '    this.retune     = p.retune     != null ? p.retune     : 0.35;',
    '    // 【2026-09-10 商用级升级】Auto-Tune Pro 三大关键件补齐：',
    '    //   flex     = Flex-Tune 容差带(0~1) -> 唱得够准(死区内)就完全不动，杜绝"微修抖动"',
    '    //   humanize = 长音人性化(0~1)      -> 持续长音上放松修正，保住颤音，"修了但不像修过"',
    '    //     （业界推荐 Flex-Tune 30~50、Humanize 25~50，见调研报告 9.5 节）',
    '    this.flex       = p.flex       != null ? p.flex       : 0.40;',
    '    this.humanize   = p.humanize   != null ? p.humanize   : 0.30;',
    '    this.enabled    = p.enabled    != null ? !!p.enabled : false;',
    '    var sr = sampleRate;',
    '',
    '    // ---- YIN 分析窗口 ----',
    '    this.WIN = 2048;',
    '    this.hop = 512;',
    '    this.anaBuf = new Float32Array(this.WIN);',
    '    this.anaFill = 0;',
    '    this.writeIdx = 0;',
    '    this.tauMin = Math.max(2, Math.floor(sr / 1100));  // 上限 1100Hz',
    '    this.tauMax = Math.floor(sr / 70);                 // 下限 70Hz',
    '',
    '    // ---- 当前音高状态 ----',
    '    this.curFreq = 0;',
    '    this.curConf = 0;',
    '    this.targetFreq = 0;',
    '    this.lastGoodFreq = 0;',
    '    this.silentFrames = 0;',
    '    // 【商用级·长音检测】同一音级持续帧数（每帧≈hop/sr 秒，512@48k≈10.7ms）',
    '    this.noteHoldFrames = 0;',
    '    this.lastNearest = -99;',
    '',
    '    // ---- 移调用的可变延迟线（环形缓冲，足够长）----',
    '    this.DLEN = 8192;',
    '    this.dline = new Float32Array(this.DLEN);',
    '    this.dpos = 0;',
    '    this.readPhase = 0;',
    '',
    '    // ---- 加厚用的短延迟线 ----',
    '    this.TLEN = 2048;',
    '    this.thickL = new Float32Array(this.TLEN);',
    '    this.thickR = new Float32Array(this.TLEN);',
    '    this.tpos = 0;',
    '    this.thickPhaseA = 0;',
    '    this.thickPhaseB = 0;',
    '',
    '    // ---- 齿音检测（高频能量）----',
    '    this.hpPrev = 0;',
    '    this.hfEnv = 0;',
    '    this.deEssGain = 1;',
    '',
    '    // ---- 平滑 ----',
    '    this.ratioSmooth = 1;',
    '    this.mixSmooth = 0;',
    '    this.corr = 0;',
    '    this.smoothK = 0.002;',
    '',
    '    this.port.onmessage = (e) => {',
    '      var d = e.data || {};',
    '      if (d.type === "params") {',
    '        if (d.enabled    != null) this.enabled    = !!d.enabled;',
    '        if (d.correctAmt != null) this.correctAmt = d.correctAmt;',
    '        if (d.thickenAmt != null) this.thickenAmt = d.thickenAmt;',
    '        if (d.deEssAmt   != null) this.deEssAmt   = d.deEssAmt;',
    '        if (d.formantAmt != null) this.formantAmt = d.formantAmt;',
    '        if (d.retune     != null) this.retune     = d.retune;',
    '        if (d.flex       != null) this.flex       = d.flex;',
    '        if (d.humanize   != null) this.humanize   = d.humanize;',
    '      }',
    '    };',
    '  }',
    '',
    '  // 从环形缓冲读一个样本（支持小数位置 -> 线性插值）',
    '  _readDline(pos) {',
    '    var L = this.DLEN;',
    '    var p = pos % L;',
    '    if (p < 0) p += L;',
    '    var i0 = Math.floor(p);',
    '    var i1 = (i0 + 1) % L;',
    '    var fr = p - i0;',
    '    return this.dline[i0] * (1 - fr) + this.dline[i1] * fr;',
    '  }',
    '',
    '  process(inputs, outputs) {',
    '    var input  = inputs[0];',
    '    var output = outputs[0];',
    '    if (!input || !input.length) return true;',
    '    var inCh  = input[0];',
    '    var outCh = output[0];',
    '    if (!inCh || !outCh) return true;',
    '',
    '    var sr = sampleRate;',
    '    var n  = inCh.length;',
    '    var L  = this.DLEN;',
    '',
    '    // 未启用：直通（零开销）',
    '    if (!this.enabled) {',
    '      if (outCh !== inCh) outCh.set(inCh);',
    '      return true;',
    '    }',
    '',
    '    // 平滑参数（避免爆音）',
    '    var tgtMix = 1;',
    '    this.mixSmooth += (tgtMix - this.mixSmooth) * 0.01;',
    '',
    '    var corr = this.correctAmt;',
    '    var thick = this.thickenAmt;',
    '    var dee = this.deEssAmt;',
    '    this.corr = corr;                       // 供共振峰保持判断用',
    '',
    '    // 再调速度 -> 平滑系数（对应 Auto-Tune 的 Retune Speed）',
    '    // retune=0 -> 系数极小(很慢、保留自然滑音)；retune=1 -> 系数很大(瞬间吸附、电音感)',
    '    this.smoothK = 0.0004 + this.retune * this.retune * 0.12;',
    '',
    '    for (var i = 0; i < n; i++) {',
    '      var x = inCh[i];',
    '',
    '      // ============ 1) 写入可变延迟线 ============',
    '      this.dline[this.dpos] = x;',
    '',
    '      // ============ 2) 音高分析（每 hop 个样本跑一次 YIN）============',
    '      // 【2026-09-10 修复·真 bug】旧代码先 anaBuf[anaFill]=x 把"最新样本"写进',
    '      //   窗口头部（copyWithin 后 0..hop-1 是最老位置），再从 dline 补尾 ->',
    '      //   最新 hop 段在窗口里出现两次（头+尾），波形不连续，',
    '      //   YIN 系统性测偏约 -40 音分（466Hz 测成 455.5Hz），',
    '      //   修正目标本身就是歪的 —— 这是"修音不专业"的隐藏元凶之一。',
    '      //   修法：anaFill 只做计数器，窗口内容完全由"copyWithin 前移 + dline 补尾"维护，',
    '      //   保证窗口是连续无重复的输入信号。',
    '      this.anaFill++;',
    '      if (this.anaFill >= this.hop) {',
    '        // 整块前移 hop，尾部从延迟线补最新 hop（dline 存的就是输入样本，连续）',
    '        this.anaBuf.copyWithin(0, this.hop);',
    '        for (var k = 0; k < this.hop; k++) {',
    '          var idx = this.dpos - this.hop + 1 + k;',
    '          if (idx < 0) idx += L;',
    '          this.anaBuf[this.WIN - this.hop + k] = this.dline[idx];',
    '        }',
    '        this.anaFill = 0;',
    '',
    '        // 只在有足够能量时分析（静音不修正）',
    '        var e = 0;',
    '        for (var q = 0; q < this.WIN; q += 4) e += this.anaBuf[q] * this.anaBuf[q];',
    '        e = Math.sqrt(e / (this.WIN / 4));',
    '',
    '        if (e > 0.006) {',
    '          var r = yinPitch(this.anaBuf, sr, this.tauMin, this.tauMax, 0.15);',
    '          if (r.f > 60 && r.f < 1200 && r.conf > 0.5) {',
    '            this.curFreq = r.f;',
    '            this.curConf = r.conf;',
    '            this.lastGoodFreq = r.f;',
    '            this.silentFrames = 0;',
    '',
    '            // ---- 目标音：十二平均律最近音 + 用户设定的修正力度 ----',
    '            // 【2026-09-10 商用级升级·对齐 Auto-Tune Pro 行为】',
    '            //   旧版"按比例拉"：跑调 60 音分只拉回 33 音分 -> 唱完还是不准（业余感根源）',
    '            //   商用级做法：超出容差带就【全幅拉到准】，快慢交给 retune 控制过渡',
    '            var midi = 69 + 12 * Math.log(r.f / 440) / Math.LN2;',
    '            var nearest = Math.round(midi);',
    '            var cents = (midi - nearest) * 100;   // 偏差音分',
    '',
    '            // ① Flex-Tune 容差带：唱得够准（死区内）完全不动，保住自然表情',
    '            //    DEAD = 5 + flex*40 -> flex=0.4 时约 21 音分（业界推荐 30~50）',
    '            var DEAD = 5 + this.flex * 40;',
    '            // ② 长音检测：同一音级持续越久越"长音"，按 humanize 放松修正保颤音',
    '            //    （业界推荐 Humanize 25~50；帧率 hop/sr ≈ 10.7ms，50 帧 ≈ 540ms）',
    '            if (nearest === this.lastNearest) { this.noteHoldFrames++; }',
    '            else { this.noteHoldFrames = 0; this.lastNearest = nearest; }',
    '            var sustainF = this.noteHoldFrames > 50 ? 1 : (this.noteHoldFrames > 25 ? 0.5 : 0);',
    '            var relax = 1 - this.humanize * 0.4 * sustainF;   // 长音最多放松 40%',
    '',
    '            var effCents = 0;',
    '            if (Math.abs(cents) > DEAD) {',
    '              effCents = cents - (cents > 0 ? DEAD : -DEAD);',
    '            }',
    '            // ③ 全幅拉正：corrEff = 0.6 + 0.4*corr，corr≥0.75 时基本等于 Auto-Tune',
    '            var corrEff = 0.6 + 0.4 * corr;',
    '            var pull = effCents * corrEff * relax;',
    '            var targetMidi = midi - pull / 100;',
    '            this.targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);',
    '          } else {',
    '            this.silentFrames++;',
    '          }',
    '        } else {',
    '          this.silentFrames++;',
    '        }',
    '      }',
    '',
    '      // ============ 3) 音准修正：可变速率读取（移调）============',
    '      var y = x;',
    '      if (corr > 0.01 && this.targetFreq > 0 && this.curFreq > 0 && this.silentFrames < 12) {',
    '        var ratio = this.targetFreq / this.curFreq;',
    '        // 限制移调范围，避免极端失真（最多 ±1.2 半音）',
    '        var maxR = Math.pow(2, 1.2 / 12);',
    '        if (ratio > maxR) ratio = maxR;',
    '        if (ratio < 1 / maxR) ratio = 1 / maxR;',
    '        // 平滑过渡：用 retune 决定的系数（慢=自然滑音，快=快速吸附）',
    '        this.ratioSmooth += (ratio - this.ratioSmooth) * this.smoothK;',
    '',
    '        // 以变速读取历史样本 = 移调（同时产生轻微延迟）',
    '        this.readPhase += this.ratioSmooth;',
    '        var back = L * 0.5;                    // 读取位置回溯（提供插值余量）',
    '        var readPos = this.dpos - back + (this.readPhase % 64);',
    '        y = this._readDline(readPos);',
    '        // 交叉淡化：修正越强混入原声越少（旧版固定 0.85/0.15 会把拉正效果稀释掉）',
    '        var wet = 0.8 + 0.2 * corr;',
    '        y = y * wet + x * (1 - wet);',
    '      } else {',
    '        this.ratioSmooth += (1 - this.ratioSmooth) * 0.01;',
    '      }',
    '',
    '      // ============ 4) 齿音抑制（de-esser）============',
    '      if (dee > 0.01) {',
    '        // 一阶高通提取高频（齿音能量集中在 5kHz+）',
    '        var hpCoef = 0.85;',
    '        var hf = y - this.hpPrev;',
    '        this.hpPrev = y * (1 - hpCoef) + this.hpPrev * hpCoef;',
    '        var hfAbs = hf < 0 ? -hf : hf;',
    '        this.hfEnv += (hfAbs - this.hfEnv) * (hfAbs > this.hfEnv ? 0.5 : 0.002);',
    '        // 高频过强时衰减',
    '        var TH = 0.05;',
    '        if (this.hfEnv > TH) {',
    '          var over = (this.hfEnv - TH) / TH;',
    '          var reduce = 1 / (1 + over * 2.5 * dee);',
    '          this.deEssGain += (reduce - this.deEssGain) * 0.02;',
    '        } else {',
    '          this.deEssGain += (1 - this.deEssGain) * 0.004;',
    '        }',
    '        y *= this.deEssGain;',
    '      }',
    '',
    '      // ============ 5) 人声加厚（短延迟双声部）============',
    '      if (thick > 0.01) {',
    '        this.thickL[this.tpos] = y;',
    '        // 两个不同延迟时间 -> 双声部错开，产生厚度',
    '        // 注意：延迟量必须取整！',
    '        // thickL 是 Float32Array，用小数当下标会取到 undefined，',
    '        // undefined 参与乘法 -> NaN，会污染整条输出链路（电平爆满、听不到声）。',
    '        var dA = Math.round(12 + thick * 18);    // ~12~30 采样点',
    '        var dB = Math.round(29 + thick * 40);    // ~29~69 采样点',
    '        var TL = this.TLEN;',
    '        var pa = this.tpos - dA; if (pa < 0) pa += TL;',
    '        var pb = this.tpos - dB; if (pb < 0) pb += TL;',
    '        var va = this.thickL[pa];',
    '        var vb = this.thickL[pb];',
    '        if (!(va === va)) va = 0;',
    '        if (!(vb === vb)) vb = 0;',
    '        // 加厚：原声 + 两个错开分量（按强度混合）',
    '        var wet = thick * 0.34;',
    '        y = y * (1 - wet * 0.5) + (va * 0.6 + vb * 0.4) * wet;',
    '        this.tpos++; if (this.tpos >= TL) this.tpos = 0;',
    '      }',
    '',
    '      // ============ 5.5) 输出兜底：任何一步算出 NaN 都退回干声 ============',
    '      if (!(y === y)) y = x;',
    '',
    '      // ============ 6) 写回 + 推进 ============',
    '      outCh[i] = y;',
    '      this.dpos++; if (this.dpos >= L) this.dpos = 0;',
    '      if (this.readPhase >= 1024) this.readPhase -= 1024;',
    '    }',
    '',
    '    // ============ 7) 共振峰保持（formant preservation）============',
    '    // 整块处理：只有当真的在移调、且用户开了保持时才跑。',
    '    // 目的：移调后把"原始共振峰包络"贴回去，消除花栗鼠/怪兽音。',
    '    if (this.corr > 0.01 && this.formantAmt > 0.01 &&',
    '        this.targetFreq > 0 && this.curFreq > 0 && this.silentFrames < 12) {',
    '      this._formantFix(inCh, outCh, n);',
    '    }',
    '',
    '    return true;',
    '  }',
    '',
    '  /* ------------------------------------------------------------------',
    '   * 共振峰保持：把移调后输出的共振峰包络，替换成原始输入的包络。',
    '   *',
    '   * 分块做（每块 128 样本），用 512 点窗求 LPC：',
    '   *   1) 取原始输入 inCh 的 LPC 系数 aIn（描述原始共振峰）',
    '   *   2) 取移调输出 outCh 的 LPC 系数 aOut（描述被带偏的共振峰）',
    '   *   3) 用 aOut 做分析滤波 -> 白化激励 e',
    '   *   4) 用 aIn 做合成滤波 -> e 贴回原始包络',
    '   *   5) 按 formantAmt 与原输出交叉淡化',
    '   * ------------------------------------------------------------------ */',
    '  _formantFix(inCh, outCh, n) {',
    '    var W = LPC_WIN;',
    '    var a, r, e, tmp, i;',
    '',
    '    // ---- 用输入填满分析窗（不足部分沿用上一块）----',
    '    if (!this.fIn) {',
    '      this.fIn  = new Float32Array(W);',
    '      this.fOut = new Float32Array(W);',
    '      // 注意：fWet / fE 必须按"窗长 W"分配，不能按块长 n！',
    '      // 因为 lpcAnalysis / lpcSynthesis 是按 W 个样本处理的。',
    '      // 如果按 n(128) 分配、却写 W(512) 个点，超出部分会被静默丢弃，',
    '      // 随后交叉淡化读 fWet[W-n+i] 全是 undefined，',
    '      // 又被 NaN 守卫 continue 掉 -> 整个 stage 变成空操作（假成功）。',
    '      this.fWet = new Float32Array(W);',
    '      this.fE   = new Float32Array(W);',
    '      this.fR   = new Float32Array(LPC_ORDER + 1);',
    '      this.fAin = new Float32Array(LPC_ORDER + 1);',
    '      this.fAout= new Float32Array(LPC_ORDER + 1);',
    '      this.fMemA= new Float32Array(LPC_ORDER);',
    '      this.fMemB= new Float32Array(LPC_ORDER);',
    '      this.fGood= false;',
    '      this.fFail= 0;      // 连续失败计数（用于自检上报）',
    '      this.fDone= 0;      // 成功应用次数（用于自检上报）',
    '    }',
    '    this.fIn.copyWithin(0, n);',
    '    this.fOut.copyWithin(0, n);',
    '    for (i = 0; i < n; i++) {',
    '      this.fIn[W - n + i]  = inCh[i]  || 0;',
    '      this.fOut[W - n + i] = outCh[i] || 0;',
    '    }',
    '',
    '    // 只在窗内有足够能量时才算（静音时 LPC 无意义、且易发散）',
    '    var en = 0;',
    '    for (i = 0; i < W; i += 4) en += this.fIn[i] * this.fIn[i];',
    '    en = Math.sqrt(en / (W / 4));',
    '    if (en < 0.004) { this.fGood = false; return; }',
    '',
    '    // ---- 求两组 LPC 系数 ----',
    '    lpcAutocorr(this.fIn, 0, W, this.fR);',
    '    var eIn = lpcLevinson(this.fR, this.fAin, LPC_ORDER);',
    '    lpcAutocorr(this.fOut, 0, W, this.fR);',
    '    var eOut = lpcLevinson(this.fR, this.fAout, LPC_ORDER);',
    '    if (!(eIn > 0) || !(eOut > 0)) { this.fGood = false; return; }',
    '',
    '    // ---- 分析滤波（去掉偏移后的包络）-> 白化激励 ----',
    '    lpcAnalysis(this.fOut, 0, W, this.fAout, this.fE, this.fMemA);',
    '    // ---- 合成滤波（贴回原始包络）----',
    '    lpcSynthesis(this.fE, W, this.fAin, this.fWet, this.fMemB);',
    '',
    '    // ---- 增益对齐（关键！）----',
    '    // LPC 合成会改变整体增益（实测能到 +20dB）。',
    '    // 对齐基准取"原始输入 fIn"而不是 outCh：',
    '    //   移调链本身会衰减电平（实测 0.115 -> 0.090），',
    '    //   若以 outCh 为基准，只会把 wet 拉到"已经偏小"的电平上，',
    '    //   交叉淡化后整体仍然偏低/偏高（实测偏差 5.3dB）。',
    '    //   以 fIn（正确响度的原始信号）为基准，才能做到"只换音色不换音量"。',
    '    var eW = 0, eI = 0;',
    '    for (i = 0; i < n; i++) {',
    '      var wv = this.fWet[W - n + i];',
    '      var iv = this.fIn[W - n + i];',
    '      if (wv === undefined || !(wv === wv)) continue;',
    '      if (iv === undefined || !(iv === iv)) continue;',
    '      eW += wv * wv; eI += iv * iv;',
    '    }',
    '    var rmsW = Math.sqrt(eW / n), rmsI = Math.sqrt(eI / n);',
    '    var gain = (rmsW > 1e-9 && rmsI > 1e-9) ? rmsI / rmsW : 1;',
    '    // 限制增益范围，避免极端情况把信号拉爆',
    '    if (!(gain === gain)) gain = 1;',
    '    if (gain > 8) gain = 8;',
    '    if (gain < 0.125) gain = 0.125;',
    '',
    '    // ---- 交叉淡化：新输出取窗的尾部 n 个样本 ----',
    '    // 注意要"等电平混合"：outCh 与 v 对不齐时，',
    '    //   简单线性插值会导致 amt=0.5 处电平塌陷（梳状抵消）。',
    '    //   先各自归一到同一响度，再按 amt 加权。',
    '    var amt = this.formantAmt;',
    '    var applied = 0;',
    '    // outCh 段的实际响度（用于把两支拉到同一电平再混合）',
    '    var eO = 0;',
    '    for (i = 0; i < n; i++) {',
    '      var ov0 = outCh[i];',
    '      if (ov0 === undefined || !(ov0 === ov0)) continue;',
    '      eO += ov0 * ov0;',
    '    }',
    '    var rmsO = Math.sqrt(eO / n);',
    '    // v 侧已按 rmsI 归一 -> 整体系数',
    '    var gv = (rmsW > 1e-9 && rmsI > 1e-9) ? rmsI / rmsW : 1;',
    '    var go = (rmsO > 1e-9) ? 1 : 1;   // outCh 保持原样',
    '    for (i = 0; i < n; i++) {',
    '      var v = this.fWet[W - n + i];',
    '      // 前置：先区分"真的算出了 NaN"和"越界取到 undefined"。',
    '      // 越界是 bug，必须计入失败（否则会被静默吞掉，stage 变空操作）。',
    '      if (v === undefined) { this.fFail++; continue; }',
    '      if (!(v === v)) { this.fFail++; continue; }',
    '      v *= gv;',
    '      var mix = outCh[i] * (1 - amt) + v * amt;',
    '      // 能量保护：贴回去后如果爆掉，退回原输出（避免爆音）',
    '      if (!(mix === mix) || mix > 4 || mix < -4) { this.fFail++; continue; }',
    '      outCh[i] = mix;',
    '      applied++;',
    '    }',
    '    // 自检：整块一个样本都没贴上 = 这个 stage 实际没生效，必须上报',
    '    if (applied > 0) { this.fGood = true; this.fFail = 0; this.fDone++; }',
    '    else {',
    '      this.fGood = false;',
    '      if (this.fFail > 200 && !this.fWarned) {',
    '        this.fWarned = true;',
    '        this.port.postMessage({ type: "formant-dead", fail: this.fFail });',
    '      }',
    '    }',
    '  }',
    '}',
    '',
    'registerProcessor("voice-fx", VoiceFXProcessor);'
  ].join('\n');


  /* ==================================================================
   * 三、导出
   * ================================================================== */

  global.PitchUtil = PitchUtil;
  global.VOICE_FX_SRC = VOICE_FX_SRC;

})(window);
