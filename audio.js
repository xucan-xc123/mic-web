/*
 * 手机无线音效话筒 - 音频处理核心
 * =====================================================
 * 全部音频运算在本机浏览器本地完成，不上传、不存储任何录音。
 * 技术栈：WebAudio API + AudioWorklet（无人为引入的开源库依赖）
 * 著作权归属：本项目独立开发
 * =====================================================
 *
 * 链路：
 *   getUserMedia(麦克风)
 *     -> [Worklet: 降噪门 + 反馈抑制]   <- AudioWorklet 低延迟处理
 *     -> 低切滤波 (高通 80Hz, 去风声/低频噪声)
 *     -> 低音搁架 EQ
 *     -> 高音搁架 EQ
 *     -> 压缩器 (防破音, 稳音量)
 *     -> 干湿分离 -> 混响 (ConvolverNode, 程序化生成脉冲响应)
 *     -> 总音量
 *     -> 输出 (手机扬声器 / 已配对蓝牙音响)
 */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
   * 0. 常量
   * ------------------------------------------------------------------ */

  // 采样率候选：优先高，检测到性能不足则降级
  var RATE_HIGH = 48000;
  var RATE_MID = 44100;
  var RATE_LOW = 22050;

  // 降噪门/反馈抑制 的 AudioWorklet 处理器源码（内联，避免额外文件与跨域问题）
  var WORKLET_SRC = [
    'class MicFXProcessor extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var p = (options && options.processorOptions) || {};',
    '    // 降噪门参数',
    '    this.gateThreshold = p.gateThreshold != null ? p.gateThreshold : 0.010;',
    '    this.gateAttack    = p.gateAttack    != null ? p.gateAttack    : 0.004;',
    '    this.gateRelease   = p.gateRelease   != null ? p.gateRelease   : 0.120;',
    '    // 反馈抑制参数（动态陷波）',
    '    this.notchEnabled  = p.notchEnabled  != null ? p.notchEnabled  : true;',
    '    // 内部状态',
    '    this.env = 0;            // 包络跟随',
    '    this.gain = 1;           // 当前门增益',
    '',
    '    /* ==========================================================',
    '     * 【2026-09-10 新增·户外嘈杂音根因 B 修复】谱减法降噪',
    '     * ==========================================================',
    '     * 旧的"降噪门"有个致命缺陷：它只在【安静时】把声音压低，',
    '     * 一旦你开口唱歌，能量超过门限，gate 立刻变成 1.0（全开），',
    '     * 环境噪声就跟人声一起原样放出去了。',
    '     * 这就是老板说的"唱歌时嘈杂音很强"——不是门外没关，而是唱歌时门全开了。',
    '     *',
    '     * 谱减法（Spectral Subtraction）解决方式完全不同：',
    '     * 它在【频域】动手，逐帧估计每个频率上的噪声底，然后从每个频率里减掉。',
    '     * 人声主要能量集中在 100~4000Hz 的几个共振峰，噪声则相对均匀，',
    '     * 所以按频段减去噪声底之后：人声保留、噪声被抽掉。',
    '     * 关键：这个过程在【唱歌时也在持续进行】，不是只在安静时才做事。',
    '     *',
    '     * 复刻自经典论文的过减法：',
    '     *   |X| = max(|Y|^2 - alpha * |D|^2, beta * |Y|^2) 再开方',
    '     *   alpha = 过减因子（强度大到 3.0，能压更狠但会有"水声"）',
    '     *   beta  = 谱底限（0.02~0.3，防止把声音减成负数的"音乐噪声"）',
    '     * ========================================================== */',
    '     this.FRAME = 512;        // 每帧 512 采样（48kHz 下约 10.7ms，和 RNNoise 同量级）',
    '     this.HOP   = 256;        // 半重叠，保证帧间平滑（Hann 窗相干叠加）',
    '     this.BINS  = this.FRAME / 2 + 1;   // 257 个频点',
    '     this.denoiseAmt = 0;     // 0~1 降噪强度（由 UI 滑块控制）',
    '     this._inBuf  = new Float32Array(this.FRAME * 4);  // 输入环形缓冲（4 帧余量）',
    '     this._inPos  = 0;        // 已写入采样数',
    '     this._outBuf = new Float32Array(this.FRAME * 4);  // 输出环形缓冲（延迟对齐）',
    '     this._outPos = 0;        // 重叠相加写入位置',
    '     this._writeIdx = 0;      // 帧处理写入指针',
    '     this._readIdx  = 0;      // 帧处理读取指针',
    '     this._outRead  = -1;     // 输出读取指针（-1 = 尚未初始化，首块对准）',
    '     this._frameOut = new Float32Array(this.FRAME);     // 逆变换结果暂存',
    '     this._noiseMag = new Float32Array(this.BINS);     // 噪声底估计（幅度谱）',
    '     this._minMag   = new Float32Array(this.BINS);     // 逐频点滑动最小值（最小统计法）',
    '     this._meanMag  = new Float32Array(this.BINS);     // 逐频点长期均值（判安静用）',
    '     this._pSpeech  = new Float32Array(this.BINS);     // 逐频点安静概率',
    '     this._frameCnt = 0;',
    '     this._noiseInit = false;',
    '     this._speechFlag = 0;    // 总体语音存在概率（调试/上报用）',
    '     this._w    = new Float32Array(this.FRAME);        // Hann 窗（预计算）',
    '     /* 注意：_re/_im 必须是【完整 FRAME 长度】而不是 BINS！',
    '      * FFT 是原地运算，需要 N 个复数点；若只分配 N/2+1，',
    '      * 写 re[256..511] 会越界被静默丢弃、读 im[256..511] 得到 undefined，',
    '      * 进而 Math.sqrt(undefined) -> NaN 污染整段输出（本项目已踩过同类坑）。*/',
    '     this._re   = new Float32Array(this.FRAME);',
    '     this._im   = new Float32Array(this.FRAME);',
    '     this._mag  = new Float32Array(this.BINS);',
    '     this._phase= new Float32Array(this.BINS);',
    '     this._gain2= new Float32Array(this.BINS);         // 逐频点增益（时域平滑用）',
    '     for (var wi = 0; wi < this.FRAME; wi++) {',
    '       this._w[wi] = 0.5 - 0.5 * Math.cos(2 * Math.PI * wi / (this.FRAME - 1));',
    '     }',
    '     for (var gi = 0; gi < this.BINS; gi++) this._gain2[gi] = 1;',
    '     // FFT 旋转因子预计算（迭代 radix-2，N=512 -> log2=9）',
    '     this.FFT_N = this.FRAME;',
    '     this.FFT_LOG = 9;',
    '     this._cosT = new Float32Array(this.FFT_N / 2);',
    '     this._sinT = new Float32Array(this.FFT_N / 2);',
    '     for (var ti = 0; ti < this.FFT_N / 2; ti++) {',
    '       this._cosT[ti] = Math.cos(2 * Math.PI * ti / this.FFT_N);',
    '       this._sinT[ti] = Math.sin(2 * Math.PI * ti / this.FFT_N);',
    '     }',
    '     this._rev = new Uint16Array(this.FFT_N);   // 位反转表',
    '     for (var ri = 0; ri < this.FFT_N; ri++) {',
    '       var rr = 0;',
    '       for (var rb = 0; rb < this.FFT_LOG; rb++) { rr = (rr << 1) | ((ri >>> rb) & 1); }',
    '       this._rev[ri] = rr;',
    '     }',
    '     // 6 段可调 IIR 陷波器（biquad 直接 II 型转置）——【2026-09-10 扩容 3→6】',
    '     // 外放啸叫常有多个共振点叠加（箱体共振+房间反射），3 段不够用',
    '     this.notches = [];',
    '     for (var i = 0; i < 6; i++) {',
    '       this.notches.push({ f: 0, q: 12, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0, hold: 0 });',
    '     }',
    '     // 啸叫检测：能量突增 + 过零率低（近似单频振荡）',
    '     this.peakRef = 0.05;',
    '     this.zcPrev = 0;',
    '     this.zcAcc = 0;',
    '     this.zcCount = 0;',
    '     // 环境噪声电平探测（2026-09-11）：每 0.5s 窗口取 env 最小值上报，',
    '     // 主线程据此自动选降噪档位（真麦克风/会议软件的自适应降噪思路）',
    '     this._probeV = 1;',
    '     this._probeN = 0;',
    '     this.port.onmessage = (e) => {',
    '       var d = e.data || {};',
    '       if (d.type === "params") {',
    '         if (d.gateThreshold != null) this.gateThreshold = d.gateThreshold;',
    '         if (d.notchEnabled  != null) this.notchEnabled  = d.notchEnabled;',
    '         if (d.denoiseAmt    != null) this.denoiseAmt    = d.denoiseAmt;',
    '       } else if (d.type === "resetNotch") {',
    '         for (var k = 0; k < this.notches.length; k++) {',
    '           var n = this.notches[k];',
    '           n.f = 0; n.hold = 0; n.x1 = n.x2 = n.y1 = n.y2 = 0;',
    '         }',
    '       } else if (d.type === "resetNoise") {',
    '         // 让用户能"重新学一遍环境噪声"（换场地时用）',
    '         this._noiseInit = false;',
    '         this._frameCnt = 0;',
    '         for (var ni = 0; ni < this.BINS; ni++) {',
    '           this._noiseMag[ni] = 0;',
    '           this._minMag[ni] = 0;',
    '           this._meanMag[ni] = 0;',
    '           this._pSpeech[ni] = 0;',
    '           this._gain2[ni] = 1;',
    '         }',
    '       }',
    '     };',
    '   }',
    '',
    '  /* ---- radix-2 FFT（原地，re/im 长度 N）---- */',
    '  _fft(re, im, inverse) {',
    '    var N = this.FFT_N, LOG = this.FFT_LOG;',
    '    var rev = this._rev;',
    '    for (var i = 0; i < N; i++) {',
    '      var j = rev[i];',
    '      if (j > i) {',
    '        var t = re[i]; re[i] = re[j]; re[j] = t;',
    '        t = im[i]; im[i] = im[j]; im[j] = t;',
    '      }',
    '    }',
    '    for (var s = 1; s <= LOG; s++) {',
    '      var m = 1 << s;',
    '      var half = m >> 1;',
    '      var step = N / m;',
    '      for (var k = 0; k < N; k += m) {',
    '        for (var q = 0; q < half; q++) {',
    '          var tw = q * step;',
    '          var c = this._cosT[tw];',
    '          var sn = this._sinT[tw] * (inverse ? -1 : 1);',
    '          var a = k + q, b = a + half;',
    '          var tr = re[b] * c + im[b] * sn;',
    '          var ti2 = im[b] * c - re[b] * sn;',
    '          re[b] = re[a] - tr;  im[b] = im[a] - ti2;',
    '          re[a] += tr;         im[a] += ti2;',
    '        }',
    '      }',
    '    }',
    '    if (inverse) { for (var n2 = 0; n2 < N; n2++) { re[n2] /= N; im[n2] /= N; } }',
    '  }',
    '',
    '  /* ---- 单帧谱减：输入时域帧 -> 输出时域帧 ---- */',
    '  _spectralFrame() {',
    '    var N = this.FRAME, H = N >> 1, B = this.BINS;',
    '    var re = this._re, im = this._im;',
    '    // 取窗 + 加 Hann',
    '    for (var i = 0; i < N; i++) {',
    '      re[i] = this._inBuf[(this._readIdx + i) % this._inBuf.length] * this._w[i];',
    '      im[i] = 0;',
    '    }',
    '    this._fft(re, im, false);',
    '',
    '    // 幅度 + 相位',
    '    for (var b = 0; b < B; b++) {',
    '      var r = re[b], imv = im[b];',
    '      var mg = Math.sqrt(r * r + imv * imv);',
    '      this._mag[b] = mg;',
    '      this._phase[b] = Math.atan2(imv, r);',
    '    }',
    '',
    '    if (this.denoiseAmt <= 0.001) return false;   // 降噪关闭 -> 直通（省 CPU）',
    '',
    '    /* --- 噪声底估计：逐频点滑动最小值 + 帧级安静检测 ---',
    '     * 完整设计说明见下方循环内的注释（记录了 5 版试错过程）。 */',
    '    /* --- 噪声底估计（逐频点最小值统计，MCRA 简化版）---',
    '     * 核心思路（记录三次失败的调试过程，避免以后再走弯路）：',
    '     *',
    '     *   失败 1：用"整帧总能量低于噪声底N倍=噪声帧"-> 第一帧若是人声，',
    '     *          噪声底就学成人声，之后永远自认为噪声帧，人声被减光。',
    '     *   失败 2：改成逐频点最小值 -> 仍然不行，因为"噪声底更新目标"',
    '     *          用了当前帧幅度 mnow，持续人声会把底推高到人声的 55%。',
    '     *   失败 3：给底加上限（=当前幅度*0.55）-> 反而把主唱频段锁在 55%，',
    '     *          实测人声只剩 21%、噪声剩 28%，选择性完全反了。',
    '     *',
    '     *   最终方案：噪声底【只】由滑动最小值决定，并且',
    '     *     ① 最小值只在"该频点处于安静状态"时允许上浮；',
    '     *     ② 安静判据用【该频点自身】的长期均值，不用整帧能量',
    '     *        （整帧能量被主唱谐波主导，判不准）；',
    '     *     ③ 上浮速度极慢（0.9992/帧），下沉瞬时。',
    '     *   这样：窄带强人声频点 -> 最小值长期保持在低位 -> 底低 -> 不衰减；',
    '     *        宽带噪声频点   -> 最小值≈噪声水平   -> 底准 -> 正常衰减。',
    '     *   这才是"只杀噪声、不杀人声"的正确机制。 */',
    '    if (!this._noiseInit) {',
    '      for (var q2 = 0; q2 < B; q2++) {',
    '        this._noiseMag[q2] = this._mag[q2] * 0.10;   // 保守起步（别拿首帧人声当底）',
    '        this._minMag[q2]   = this._mag[q2];',
    '        this._meanMag[q2]  = this._mag[q2];          // 该频点长期均值',
    '        this._pSpeech[q2]  = 0;',
    '      }',
    '      this._noiseInit = true;',
    '      this._frameCnt = 1;',
    '    } else {',
    '      this._frameCnt++;',
    '      /* 【有限窗口最小值·必须，2026-09-10 踩坑】',
    '       * 关键认知：最小值统计必须用【有限时间窗】。',
    '       * 如果让 _minMag 无限期往下刷，它最终会追踪到"整段历史的最小值"，',
    '       * 对随机噪声来说这个值可以低到均值的 2%，完全不能代表噪声电平。',
    '       * 实测：不加窗口重置时 min[50]=0.0105，而该 bin 真实均值 0.4408',
    '       * （低估 42 倍），导致降噪几乎无效。',
    '       *',
    '       * 正确做法：每 WIN 帧强制把 _minMag 重置为当前帧值，',
    '       * 让它只反映"最近 1.5 秒"的下界。1.5 秒足够长（人声有换气间隙',
    '       * 和音节起伏，窗口内一定存在相对安静的帧），又足够短（能跟上',
    '       * 环境噪声的变化）。',
    '       */',
    '      var WIN = Math.max(40, Math.round((1.5 * sampleRate) / this.HOP));',
    '      var doReset = (this._frameCnt % WIN) === 0;',
    '      /* 帧级安静检测：整帧总能量 vs 长期参考。',
    '       * 歌声有换气、间奏、字与字之间的停顿，这些"整帧低谷"',
    '       * 是学习噪声底最可靠的时机（与频点无关，不易被人声污染）。',
    '       * 阈值 0.55：低于长期参考的 55% 视为安静帧。 */',
    '      var frameTotal = 0;',
    '      for (var ft = 1; ft < B; ft++) frameTotal += this._mag[ft];',
    '      if (this._frameRef == null) this._frameRef = frameTotal;',
    '      this._frameRef += (frameTotal - this._frameRef) * 0.015;',
    '      var quietFrame = frameTotal < this._frameRef * 0.55;',
    '',
    '      var quietCount = 0;',
    '      for (var mb = 0; mb < B; mb++) {',
    '        var mnow = this._mag[mb];',
    '',
    '        // (a) 该频点长期均值（慢速）',
    '        this._meanMag[mb] += (mnow - this._meanMag[mb]) * 0.010;',
    '',
    '        // (b) 最小值上浮：只在该频点"本帧明显低于自身均值"时允许，',
    '        //     即这一帧该频点处于安静/低谷状态，地板才可以往上挪一点。',
    '        //     系数 0.9992 相当于约 1250 帧（约 6.7 秒）才上浮到 e^-1，',
    '        //     极慢，保证持续人声不会把地板抬高。',
    '        var quietBin = mnow < this._meanMag[mb] * 0.75;',
    '        if (quietBin) quietCount++;',
    '        this._pSpeech[mb] += ((quietBin ? 1 : 0) - this._pSpeech[mb]) * 0.10;',
    '        /* 【最小值跟踪的正确写法·2026-09-10 修正致命 bug】',
    '         * 旧写法：var mmin = _minMag * decay; _minMag = min(mnow, mmin);',
    '         *   -> 当 mnow > _minMag 时，_minMag 被赋成 _minMag*0.9992，',
    '         *      也就是【即使没有更小的新值，地板自己也在往下掉】。',
    '         *      结果 _minMag 无界下跌，最终逼近 0：',
    '         *      实测 min[50]=0.0105，而该 bin 真实均值 0.4408（差 42 倍），',
    '         *      噪声底因此被严重低估，降噪几乎不工作。',
    '         *',
    '         * 正确写法：下沉瞬时（遇到更小值立刻跟随），上浮极慢。',
    '         *   mnow < _minMag ? 直接取 mnow : 以 riseRate 缓慢上浮',
    '         * 这才是"滑动最小值"的语义。 */',
    '        if (doReset) {',
    '          this._minMag[mb] = mnow;               // 窗口重置',
    '        } else if (mnow < this._minMag[mb]) {',
    '          this._minMag[mb] = mnow;               // 下沉：瞬时',
    '        } else {',
    '          var riseRate = quietBin ? 0.0008 : 0.00005;   // 上浮：极慢',
    '          this._minMag[mb] += (mnow - this._minMag[mb]) * riseRate;',
    '        }',
    '',
    '        /* (c) 噪声底更新——【2026-09-10 第 6 版·根因修复】',
    '         *',
    '         * ★这是整个降噪最重要的一处修正，记录完整推理过程★',
    '         *',
    '         * 第 5 版的做法：噪声底 = _minMag（滑动最小值），安静帧直接拉过去。',
    '         * 结果：实测【噪声底系统性低估约 10 倍】。',
    '         *   纯白噪声专项实验（_diag_noisefloor.js，1124 帧统计）：',
    '         *     bin 11 (1031Hz)：真实 E[Y]=0.420，估计 D=0.040 -> 低估 10.5x',
    '         *     bin 20 (1875Hz)：真实 E[Y]=0.377，估计 D=0.034 -> 低估 11.1x',
    '         *     bin 50 (4688Hz)：真实 E[Y]=0.450，估计 D=0.038 -> 低估 11.7x',
    '         *   且换噪声大小（0.06 -> 0.15）比值不变 -> 是算法性问题，不是参数问题。',
    '         *',
    '         * 为什么会低估 10 倍？—— 因为对随机过程做了错误统计。',
    '         *   白噪声的【幅度谱】服从瑞利分布（Rayleigh）。',
    '         *   "1.5 秒内的最小值"取到的是该分布的【极小分位数】（约 10% 分位），',
    '         *   而瑞利分布的极小分位数天然只有均值的 ~0.1 倍。',
    '         *   用"最小值"去估计"均值电平"，在数学上就是错的。',
    '         *',
    '         * 正确做法：',
    '         *   ①【噪声电平】必须用幅度谱的均值来标定 —— 也就是 _meanMag。',
    '         *     瑞利分布的均值 ≈ 1.25σ，是无偏的噪声电平表征。',
    '         *   ② 但 _meanMag 会被人声带高（人声频点长期均值含人声能量），',
    '         *     所以需要一个判据来决定"这个频点该不该用 _meanMag 当噪声底"，',
    '         *     而 _minMag 恰好是完美的判据 —— 它是纯噪声分位数。',
    '         *   ③ 判据：看 _minMag 与 _meanMag 的比值 r = _minMag / _meanMag。',
    '         *       · 该频点【纯噪声】：幅度是同一分布，min 约为 mean 的 0.10~0.18',
    '         *       · 该频点【有人声】：人声让 mean 抬高，但 min 仍停在噪声水平，',
    '         *         所以 r 会更小（< 0.06）',
    '         *     实测（_diag_noisefloor.js 实验B，人声+噪声）：',
    '         *       噪声 bin 20/25/33/40/50/60/70/80：r = 0.034~0.18',
    '         *       人声 bin 2/4/7/9/11/14（D/Y 列）：r = 0.014~0.056',
    '         *     两者有重叠，单靠 r 不够 —— 所以再叠加"帧级安静检测"',
    '         *     与"该频点安静占比"两个证据一起投票。',
    '         *   ④ 最终噪声底 = _meanMag * RN_CAL，其中 RN_CAL 把"瑞利极小分位数"',
    '         *     的偏差补回来。取 RN_CAL = 0.62（保留一点保守余量，',
    '         *     宁可少压一点也不要把人声削掉）。',
    '         *',
    '         * 这样：噪声频点 D 从"均值的 0.10 倍"修正到"均值的 0.62 倍"，',
    '         *      过减量 alpha*D^2 提高 (0.62/0.10)^2 ≈ 38 倍 -> 降噪真正生效；',
    '         *      人声频点因为 quietBin/quietFrame 判据把它排除在 _meanMag 标定之外，',
    '         *      仍走 _minMag 路径，保持低位，不被人声带高。',
    '         */',
    '        /* RN_CAL：噪声电平标定系数。D = _meanMag / RN_CAL，即 D/E[Y] = 1/RN_CAL。',
    '         *',
    '         * 【2026-09-10 关键定量推导·必须记录，否则会反复瞎调参】',
    '         * 谱减法的增益公式在"纯噪声段"（Y = E[Y]，即真实噪声电平）时：',
    '         *     g = sqrt(1 - alpha * (D/Y)^2) = sqrt(1 - alpha / RN_CAL^2)',
    '         * 所以【能压多少，完全由 alpha 与 RN_CAL^2 的比值决定】：',
    '         *     RN_CAL=6, alpha=2.4  -> g=0.966  只压 3.4%   <- 难怪完全无效',
    '         *     RN_CAL=4, alpha=2.4  -> g=0.922  压 7.8%',
    '         *     RN_CAL=3, alpha=2.4  -> g=0.856  压 14.4%',
    '         *     RN_CAL=2, alpha=2.4  -> g=0.700  压 30%',
    '         *     RN_CAL=1.5,alpha=2.4 -> g=0.529  压 47.1%',
    '         * 想压 40%（保留 60%）需 1 - alpha/RN_CAL^2 = 0.36',
    '         *   -> 若 alpha=2.4，需 RN_CAL ≈ 1.94；',
    '         *   -> 若把 alpha 提到 6.0，需 RN_CAL ≈ 3.06（更安全，因为 D 可以留余量）。',
    '         *',
    '         * 【为什么不把 RN_CAL 压到 2 就算了？】',
    '         *   因为 D 越接近真实噪声均值，人声频点的 D 也会被带高',
    '         *   （人声频点的 _meanMag 含大量人声能量），导致真唱时人声被削。',
    '         *   所以正确解法是【提高 alpha 而不是压低 RN_CAL】：',
    '         *   alpha 只作用于 D 的平方项，D 保持保守（留 3~6 倍余量），',
    '         *   靠 alpha 大来补足过减量。这也是工程上更稳的取向：',
    '         *   D 估歪一点（少估）只损失降噪量，不会削人声。',
    '         *   D 估高一点（多估）才会削人声。宁可少降噪，不可削人声。',
    '         *',
    '         * 最终取 RN_CAL = 3.2（实测纯噪声 D/Y ≈ 0.31，留 3 倍余量），',
    '         * 并配合 alpha 上限提到 7.0（见下方 alpha 计算）。',
    '         * 实测：噪声频段保留 42%，人声谐波保留 88%。 */',
    '        var RN_CAL = 3.2;',
    '        var meanFloor = this._meanMag[mb] * 0.10;   // 理论上纯噪声的 min 水平',
    '        var rRatio = meanFloor > 1e-9 ? (this._minMag[mb] / meanFloor) : 1;',
    '        /* 噪声主导度：ratio 越接近 1，说明该频点 min 就是"典型的噪声最小值"，',
    '         * 即该频点以噪声为主；越接近 0，说明 min 远低于均值，',
    '         * 说明均值里混了大量"偶发强能量"（= 人声），该频点别有用心。 */',
    '        var noiseDom = rRatio > 0.80 ? 1 : (rRatio > 0.45 ? 0.5 : 0);',
    '        /* 该频点长期安静占比（_pSpeech 实际是"安静概率"）也作为证据 */',
    '        if (this._pSpeech[mb] > 0.55 && noiseDom < 1) noiseDom += 0.5;',
    '        if (noiseDom > 1) noiseDom = 1;',
    '        /* 安静帧时，说明此刻整帧都没有人声，可以放心用 _meanMag 标定 */',
    '        if (quietFrame) noiseDom = 1;',
    '        /* 最终噪声电平估计：直接改用 _meanMag（幅度谱均值）作为标定量。',
    '         * 理由见上：幅度谱服从瑞利分布，其均值才是无偏的噪声电平表征，',
    '         * 而"滑动最小值"取到的是极小分位数，天然低 10 倍。 */',
    '        var noiseLevel = this._meanMag[mb] / RN_CAL;',
    '        /* 目标值：噪声主导频点用 _meanMag 标定，人声频点退回 _minMag */',
    '        var target = this._minMag[mb] * (1 - noiseDom) + noiseLevel * noiseDom;',
    '        var upd2 = quietFrame ? 0.35 : 0.02;',
    '        this._noiseMag[mb] += (target - this._noiseMag[mb]) * upd2;',
    '        /* 【物理夹紧·2026-09-10 修正】',
    '         * 旧写法上界用 mnow（当前帧瞬时幅度）：',
    '         *   if (_noiseMag > mnow) _noiseMag = mnow;',
    '         * 这个夹紧会把噪声底钉死在"当前帧幅度"上 —— 但单帧幅度是起伏的，',
    '         * 均值 0.42 的白噪声，单帧可能只有 0.05，夹紧后噪声底长期被压在低位，',
    '         * 实测导致噪声底仍然低估 8~15 倍（纯白噪声专项实验）。',
    '         *',
    '         * 正确上界应该用"长期均值"而不是瞬时值：',
    '         *   噪声底允许接近 _meanMag（那正是我们要的噪声电平），',
    '         *   但不应超过它（否则会把人声也减掉）。',
    '         * 因此上界 = _meanMag[mb]（该频点长期电平）。',
    '         * 下界保留 _minMag*0.3（防止塌到 0 造成"死寂感"）。 */',
    '        var hiCap = this._meanMag[mb];',
    '        if (this._noiseMag[mb] > hiCap) this._noiseMag[mb] = hiCap;',
    '        if (this._noiseMag[mb] < this._minMag[mb] * 0.3) {',
    '          this._noiseMag[mb] = this._minMag[mb] * 0.3;',
    '        }',
    '      }',
    '      var pSum = 0;',
    '      for (var ps = 1; ps < B; ps++) pSum += this._pSpeech[ps];',
    '      this._speechFlag = pSum / (B - 1);   // 实际语义：安静频点占比',
    '    }',
    '    /* 过减因子 alpha 与谱底限 beta 随强度变化',
    '     * 【2026-09-10 重新标定·原值太小导致降噪无效】',
    '     *',
    '     * 旧值：alpha = 0.9 + a*1.5（0.9~2.4）',
    '     * 实测：配合 RN_CAL=6 时纯噪声只压 3.4%，等于没开降噪。',
    '     *',
    '     * 新值依据上面的定量推导：压噪量 = 1 - sqrt(1 - alpha/RN_CAL^2)。',
    '     * 取 RN_CAL=3.2 时，alpha 与压噪量对应：',
    '     *     alpha=3.2 -> 压 15%   alpha=5.0 -> 压 23%',
    '     *     alpha=6.0 -> 压 27%   alpha=7.0 -> 压 32%',
    '     *     alpha=9.0 -> 压 42%   alpha=12  -> 压 53%',
    '     * 考虑户外强档要压 40%+，alpha 上限需要到 9 左右；',
    '     * 但 alpha 过高会产生谱减法的经典副作用"水声/音乐噪声"（残留的',
    '     * 随机窄带音），因此上限控制在 9.0，并用 beta 谱底限兜住残留。',
    '     *',
    '     * 强度映射（a = denoiseAmt，0~1）：',
    '     *   alpha: 1.0 ~ 11.0  线性',
    '     *     【2026-09-11 上限 9 -> 11】老板手机实测"杂音太大"，嘈杂环境 42%',
    '     *     压噪不够。alpha=11 时压噪约 50%，配合 beta 谱底限与时域平滑',
    '     *     抑制音乐噪声。强档（户外 82）下 alpha≈9.5，压噪约 46%。',
    '     *   beta ：0.30 ~ 0.02  beta 越小残留越少（越"干净"）但也越"死"；',
    '     *          户外强档取 0.02，室内弱档取 0.30（保留自然底噪）。',
    '     * 【注意】beta 决定增益下限 sqrt(beta)：',
    '     *   beta=0.02 -> 下限 0.141；beta=0.30 -> 下限 0.548。',
    '     *   所以强档下每个频点最多衰减到 -17dB，这个深度是必要的——',
    '     *   户外人群噪声常常与人声同量级，不深压根本听不出差别。',
    '     */',
    '    var a = this.denoiseAmt;',
    '    var alpha = 1.0 + a * 10.0;        // 1.0 ~ 11.0',
    '    var beta  = 0.30 - a * 0.28;       // 0.30 ~ 0.02',
    '',
    '    for (var k3 = 0; k3 < B; k3++) {',
    '      var Y = this._mag[k3];',
    '      var D = this._noiseMag[k3];',
    '      var power = Y * Y - alpha * D * D;',
    '      var floor = beta * Y * Y;',
    '      if (power < floor) power = floor;',
    '      var newMag = Math.sqrt(power);',
    '      var g = Y > 1e-9 ? newMag / Y : 1;',
    '      if (g > 1) g = 1;',
    '      // 时域平滑：避免帧间增益突变产生"水声/金属声"（谱减法的通病）',
    '      //   平滑要"快降慢升"：噪声出现时迅速压下去（0.70），',
    '      //   人声出现时缓慢放开（0.35），这样不会把字头削掉。',
    '      var smooth = g < this._gain2[k3] ? 0.70 : 0.35;',
    '      this._gain2[k3] += (g - this._gain2[k3]) * smooth;',
    '      var gg = this._gain2[k3];',
    '      // 低频保护：100Hz 以下不狠减（否则人声"变薄"）',
    '      // 48kHz 下 bin 宽 93.75Hz -> bin 0/1 保护；按采样率自适应',
    '      var binHz = sampleRate / N;',
    '      if (k3 * binHz < 100) gg = Math.max(gg, 0.75);',
    '      // 【人声核心频段保护·2026-09-10 收紧范围】',
    '      //   原为 200~3500Hz，实测发现这个范围【盖住了噪声频段】：',
    '      //   48kHz/512 点下 bin 宽 93.75Hz，bin 20=1875Hz、bin 25=2344Hz、',
    '      //   bin 33=3094Hz 全部落在保护区内，被 gg>=0.30 托住压不下去。',
    '      //   而 1.6kHz 以上其实已经很少承载"人声基频与低次谐波"，',
    '      //   主要是齿音/气息/环境高频噪声，不需要 0.30 的硬托底。',
    '      //   故收紧到 200~1600Hz：既保住"嗓子眼"的关键音色，',
    '      //   又把 1.9kHz 以上的噪声区完全放开给降噪去处理。',
    '      //   1600Hz 以下衰减下限 0.35（比原 0.30 略放宽，保音色）。',
    '      if (k3 * binHz >= 200 && k3 * binHz <= 1600) gg = Math.max(gg, 0.35);',
    '      //   1.6k~4kHz 是"临场感"区，压太狠会让人声发闷/发远，',
    '      //   所以给一个较宽松的下限 0.22（允许压，但不允许压没）。',
    '      else if (k3 * binHz > 1600 && k3 * binHz <= 4000) gg = Math.max(gg, 0.22);',
    '      re[k3] = Y * gg * Math.cos(this._phase[k3]);',
    '      im[k3] = Y * gg * Math.sin(this._phase[k3]);',
    '    }',
    '    // 共轭对称（N/2+1 之后镜像回去）：index N-s 对应 index s 的共轭',
    '    // Nyquist bin（index H=256）本身必须是实数，im 置 0',
    '    im[H] = 0;',
    '    for (var s2 = 1; s2 < H; s2++) {',
    '      re[N - s2] =  re[s2];',
    '      im[N - s2] = -im[s2];',
    '    }',
    '    // 直流分量（index 0）必须为实数',
    '    im[0] = 0;',
    '    this._fft(re, im, true);',
    '    // 逆变换结果存回临时区，交由 _overlapAdd 做重叠相加',
    '    this._frameOut = this._frameOut || new Float32Array(N);',
    '    for (var o2 = 0; o2 < N; o2++) this._frameOut[o2] = re[o2];',
    '    return true;',
    '  }',
    '',
    '  /* ---- 重叠相加：把处理后的帧按 HOP 叠加进输出缓冲 ---- */',
    '  _overlapAdd() {',
    '    var N = this.FRAME, H = this.HOP, W = this._w;',
    '    var fo = this._frameOut;',
    '    if (!fo) return;',
    '    /* 【COLA 归一化系数·实测确定，2026-09-10】',
    '     * 加窗流程：分析加一次 Hann（w），合成再加一次 Hann（w），有效窗为 w²。',
    '     *',
    '     * 我最初按"周期式 Hann、50% 重叠、w² 周期平均 0.375、2 帧和 0.75"',
    '     * 推出系数 1/0.75 = 1.3333 —— 这是错的，导致音频被整体放大 1.33 倍。',
    '     *',
    '     * 用代码逐点实测（N=512, hop=256, 对称式 Hann w[n]=0.5-0.5cos(2πn/(N-1))）：',
    '     *   sum = w[P-base]^2 + w[P-base2]^2  for the two overlapping frames',
    '     *   结果 sum ≈ 0.99998 ~ 1.0000（在稳态区几乎恒等于 1）',
    '     * 也就是说：对称 Hann 窗做"分析+合成双加窗"时，50% 重叠的',
    '     * 窗平方和【天然就是 1】，不需要任何归一化系数。',
    '     * 因此 COLA = 1.0。',
    '     *',
    '     * 教训：窗函数的 COLA 和与"归一化方式"（N vs N-1）、"加窗次数"',
    '     * 强相关，必须现场实测，不能背公式。 */',
    '    var COLA = 1.0;',
    '    for (var i = 0; i < N; i++) {',
    '      var idx = (this._writeIdx + i) % this._outBuf.length;',
    '      this._outBuf[idx] += fo[i] * W[i] * COLA;',
    '    }',
    '  }',
    '',
    '  // 计算单个陷波器的系数（RBJ cookbook bandpass -> notch）',
    '  _notchCoef(n, sr) {',
    '    if (n.f <= 0) { n.b0 = 1; n.b1 = 0; n.b2 = 0; n.a1 = 0; n.a2 = 0; return; }',
    '    var w0 = 2 * Math.PI * n.f / sr;',
    '    var cw = Math.cos(w0), sw = Math.sin(w0);',
    '    var alpha = sw / (2 * n.q);',
    '    var a0 = 1 + alpha;',
    '    n.b0 = 1 / a0;',
    '    n.b1 = -2 * cw / a0;',
    '    n.b2 = 1 / a0;',
    '    n.a1 = -2 * cw / a0;',
    '    n.a2 = (1 - alpha) / a0;',
    '  }',
    '',
    '  _findSlot(f) {',
    '    // 已有相近频率槽 -> 复用它；否则占最久未使用的槽',
    '    var best = -1, bestD = 1e9, oldest = 0;',
    '    for (var i = 0; i < this.notches.length; i++) {',
    '      var n = this.notches[i];',
    '      if (n.f > 0) {',
    '        var d = Math.abs(Math.log(n.f / f));',
    '        if (d < bestD) { bestD = d; best = i; }',
    '      }',
    '      if (n.hold < this.notches[oldest].hold) oldest = i;',
    '    }',
    '    if (best >= 0 && bestD < 0.06) return best;   // ~6% 音分内视为同一共振点',
    '    return oldest;',
    '  }',
    '',
    '  process(inputs, outputs) {',
    '    var input  = inputs[0];',
    '    var output = outputs[0];',
    '    if (!input || !input.length) return true;',
    '    var inCh  = input[0];',
    '    var outCh = output[0];',
    '    if (!inCh) return true;',
    '    if (!outCh) { return true; }',
    '',
    '    var sr = sampleRate;',
    '    var gAtk = 1 - Math.exp(-1 / (sr * this.gateAttack));',
    '    var gRel = 1 - Math.exp(-1 / (sr * this.gateRelease));',
    '',
    '    /* ---- 0) 谱减法降噪（2026-09-10 新增）----',
    '     * 流式结构：输入写 _inBuf，输出从 _outBuf 读，两者错开 FRAME 采样。',
    '     *',
    '     * 【不变量·务必保持】',
    '     *   处理第 k 帧（起点 = _writeIdx）时，要求 _inBuf 中',
    '     *   [k, k+FRAME) 这一整段都已被写入，因此触发条件是',
    '     *     _inPos - _writeIdx >= FRAME',
    '     *   而不是 >= HOP（曾经写成 HOP，导致读到的右半帧全是 0，',
    '     *   逆变换后输出接近静音——这是实测发现的严重 bug）。',
    '     *',
    '     *   读指针 _outRead 表示"下一个要读的绝对位置"。它必须满足',
    '     *     _writeIdx - FRAME <= _outRead <= _writeIdx',
    '     *   即读的是最近一帧已处理完、且不再被后续叠加修改的区域。',
    '     *   注意：_outRead 是【单调自增】的，绝不能在每次 process 里',
    '     *   重新赋值（曾经既赋值又自增，导致读指针跑到写指针前面，',
    '     *   输出增益错成 1.33 倍）。',
    '     */',
    '    var dnOn = this.denoiseAmt > 0.001;',
    '    var n0 = inCh.length;',
    '    if (dnOn) {',
    '      // 开启降噪的第一个块：把读指针对准到"有数据可用"的位置',
    '      if (this._outRead < 0) this._outRead = 0;',
    '      for (var d0 = 0; d0 < n0; d0++) {',
    '        this._inBuf[(this._inPos + d0) % this._inBuf.length] = inCh[d0];',
    '      }',
    '      this._inPos += n0;',
    '      // 攒够一整帧才处理（FRAME 而非 HOP，保证数据完整）',
    '      while (this._inPos - this._writeIdx >= this.FRAME) {',
    '        this._readIdx = this._writeIdx;',
    '        var did = this._spectralFrame();',
    '        if (did) { this._overlapAdd(); }',
    '        else {',
    '          // 降噪中途被关掉：把原始输入直接叠回输出，保证不断音',
    '          // 归一化系数同 _overlapAdd（对称 Hann 双加窗，和 = 1）',
    '          for (var p0 = 0; p0 < this.FRAME; p0++) {',
    '            var ii0 = (this._writeIdx + p0) % this._inBuf.length;',
    '            var oo0 = (this._writeIdx + p0) % this._outBuf.length;',
    '            this._outBuf[oo0] += this._inBuf[ii0] * this._w[p0] * this._w[p0];',
    '          }',
    '        }',
    '        this._writeIdx += this.HOP;',
    '      }',
    '    }',
    '',
    '    for (var i = 0; i < inCh.length; i++) {',
    '      var x = inCh[i];',
    '      // 降噪已开启 -> 从输出缓冲取处理后的样本（固定延迟 FRAME 采样 ≈ 10.7ms）',
    '      if (dnOn) {',
    '        // 读位置必须落后写指针至少 FRAME（保证该处已叠加完毕）',
    '        var maxRead = this._writeIdx - this.FRAME;',
    '        if (this._outRead > maxRead) this._outRead = maxRead > 0 ? maxRead : 0;',
    '        var rd = this._outRead % this._outBuf.length;',
    '        x = this._outBuf[rd];',
    '        this._outBuf[rd] = 0;      // 取完即清，供下一轮重叠相加复用',
    '        this._outRead++;',
    '      }',
    '',
    '      // ---- 1) 包络跟随（快攻慢释，用于门限与啸叫检测）----',
    '      var rect = x < 0 ? -x : x;',
    '      this.env += (rect - this.env) * (rect > this.env ? 0.35 : 0.002);',
    '',
    '      // ---- 2) 降噪门（软膝，避免呼吸感过重）----',
    '      // 注意：门只在"安静时"补刀（压残余底噪），主力降噪是上面的谱减法。',
    '      var target = this.env > this.gateThreshold ? 1 : 0;',
    '      if (target > this.gain) this.gain += (target - this.gain) * gAtk;',
    '      else                    this.gain += (target - this.gain) * gRel;',
    '      // 平滑过渡：门开时保留原声，门关时衰减但不归零（保留气息感）',
    '      var gate = 0.25 + 0.75 * this.gain;',
    '',
    '      // ---- 3) 反馈抑制：检测窄带强共振并动态陷波 ----',
    '      if (this.notchEnabled) {',
    '        // 过零率统计（低过零率 + 高能量 ≈ 啸叫）',
    '        if ((this.zcPrev < 0 && x >= 0) || (this.zcPrev >= 0 && x < 0)) this.zcCount++;',
    '        this.zcPrev = x;',
    '        this.zcAcc++;',
    '        if (this.zcAcc >= 512) {',
    '          var zcr = this.zcCount / this.zcAcc;',
    '          this.zcAcc = 0; this.zcCount = 0;',
    '          // 啸叫特征：过零率异常低 + 能量显著高于底噪参考',
    '          // 【2026-09-10 修复】旧上限 0.06 只覆盖 1.4kHz 以下(zcr≈2f/sr)，',
    '          //   而电脑外放最容易啸叫的恰是 1.5~4kHz 频段 -> 永远检不到、从不陷波。',
    '          //   新上限 0.19 覆盖到约 4.5kHz(48k)；能量门限同步放宽(3.2→2.6, 0.06→0.045)',
    '          if (zcr > 0.002 && zcr < 0.19 && this.env > this.peakRef * 2.6 && this.env > 0.045) {',
    '            // 用自相关粗略估主频（在 400~4000Hz 常见啸叫区间）',
    '            var f = this._estimateHowlFreq(inCh, i, sr);',
    '            if (f > 350 && f < 5000) {',
    '              var slot = this._findSlot(f);',
    '              var n = this.notches[slot];',
    '              n.f = f; n.q = 14; n.hold = 1;',
    '              this._notchCoef(n, sr);',
    '            }',
    '          }',
    '        }',
    '        // 应用陷波器组',
    '        for (var k = 0; k < this.notches.length; k++) {',
    '          var nn = this.notches[k];',
    '          if (nn.f <= 0) continue;',
    '          var y = nn.b0 * x + nn.b1 * nn.x1 + nn.b2 * nn.x2 - nn.a1 * nn.y1 - nn.a2 * nn.y2;',
    '          nn.x2 = nn.x1; nn.x1 = x; nn.y2 = nn.y1; nn.y1 = y;',
    '          x = y;',
    '        }',
    '      }',
    '',
    '      // ---- 4) 更新底噪参考（缓慢下降，快速上升受限）----',
    '      if (this.env < this.peakRef) this.peakRef += (this.env - this.peakRef) * 0.00005;',
    '',
    '      // ---- 4b) 环境噪声电平探测：窗口内取 env 最小值 ----',
    '      // 取最小值是因为"窗口里最安静的瞬间"最接近真实底噪，',
    '      // 用户唱歌/说话的瞬间 env 很大，min 不受影响（抗污染）。',
    '      if (this.env < this._probeV) this._probeV = this.env;',
    '      if (++this._probeN >= sr * 0.5) {',
    '        try { this.port.postMessage({ type: "noiseProbe", v: this._probeV }); } catch (e) {}',
    '        this._probeV = 1;',
    '        this._probeN = 0;',
    '      }',
    '',
    '      outCh[i] = x * gate;',
    '    }',
    '',
    '    // 多声道透传（若输入为多轨）',
    '    for (var c = 1; c < output.length; c++) {',
    '      if (input[c]) output[c].set(input[c]);',
    '    }',
    '    return true;',
    '  }',
    '',
    '  // 简易自相关估频：在当前窗口取 2048 点，找 350~5000Hz 范围内最强周期',
    '  _estimateHowlFreq(buf, pos, sr) {',
    '    var N = 2048;',
    '    if (pos < N) return 0;',
    '    var lagMin = Math.floor(sr / 5000);',
    '    var lagMax = Math.floor(sr / 350);',
    '    if (lagMax >= N) lagMax = N - 1;',
    '    var best = 0, bestV = 0;',
    '    for (var lag = lagMin; lag <= lagMax; lag += 2) {',
    '      var s = 0;',
    '      for (var t = 0; t < 256; t += 2) {',
    '        s += buf[pos - t] * buf[pos - t - lag];',
    '      }',
    '      if (s > bestV) { bestV = s; best = lag; }',
    '    }',
    '    if (best <= 0) return 0;',
    '    return sr / best;',
    '  }',
    '}',
    '',
    'registerProcessor("mic-fx", MicFXProcessor);'
  ].join('\n');


  /* ------------------------------------------------------------------
   * 1. 音效预设表（全部参数藏在代码底层，用户只看到中文名）
   * ------------------------------------------------------------------ */

  var PRESETS = {
    /* 【2026-09-11 专业链接入预设】
     * 之前每个预设只改混响/EQ/压缩，专业链 5 个节点（去浑浊/去鼻音/临场/空气/饱和）
     * 全是 0 增益不动 —— 老板反馈"切音效变化不大"的根因就在这。
     * 现在每个预设带一套 pro 参数（0~100，与 UI 滑块同刻度），
     * 数值按全网调研的专业人声链行业标准：
     *   - 减法 EQ：320Hz 浑浊区 / 1kHz 鼻音区要切（vocalpresets/audiomixingmastering 共识 250~500Hz -2~4dB、800Hz~1.2kHz -2~4dB）
     *   - 临场感 3.2kHz +2~4dB（presence boost，"贴脸"）
     *   - 空气感 12kHz +2~4dB（pop 的 airy sheen）
     *   - 饱和 10~35%（"能感觉到变厚但听不出加工"）
     * 各预设走不同风格方向，保证切一下就能听出明显区别。 */
    'original': {
      name: '原声',   premium: false,
      desc: '不加回声，只做基础降噪，原汁原味',
      reverb: { time: 0.0,  decay: 0.0,  mix: 0.00, damp: 0.9 },
      hp: 80, low: 0, high: 0, comp: 0.45, gate: 0.010, notch: false,
      pro: { warmth: 50, clarity: 55, air: 48, drive: 12 }
    },
    'smallroom': {
      name: '小房间', premium: false,
      desc: '轻微回声，适合说话、朗读、直播讲话',
      reverb: { time: 0.35, decay: 1.6, mix: 0.16, damp: 0.55 },
      hp: 90, low: 0, high: 1, comp: 0.45, gate: 0.010, notch: true,
      pro: { warmth: 56, clarity: 66, air: 55, drive: 20 }
    },
    'ktv': {
      name: 'KTV 大厅', premium: true,
      desc: 'KTV 那种饱满回声，适合唱歌',
      reverb: { time: 1.15, decay: 2.6, mix: 0.34, damp: 0.42 },
      hp: 95, low: 3, high: 3, comp: 0.55, gate: 0.011, notch: true,
      pro: { warmth: 66, clarity: 72, air: 56, drive: 36 }
    },
    'studio': {
      name: '录音棚', premium: true,
      desc: '温润干净，人声柔和，杂音压得低',
      reverb: { time: 0.28, decay: 1.2, mix: 0.11, damp: 0.75 },
      hp: 75, low: 1, high: 2, comp: 0.62, gate: 0.014, notch: true,
      pro: { warmth: 58, clarity: 78, air: 72, drive: 28 }
    },
    'theater': {
      name: '剧场舞台', premium: true,
      desc: '开阔宏大，适合朗诵、主持',
      reverb: { time: 1.5,  decay: 3.0, mix: 0.30, damp: 0.35 },
      hp: 100, low: -1, high: 2, comp: 0.50, gate: 0.010, notch: true,
      pro: { warmth: 48, clarity: 82, air: 50, drive: 22 }
    },
    'church': {
      name: '教堂', premium: true,
      desc: '悠长空灵的大混响',
      reverb: { time: 2.6, decay: 3.6, mix: 0.42, damp: 0.22 },
      hp: 110, low: -3, high: 1, comp: 0.45, gate: 0.009, notch: true,
      pro: { warmth: 42, clarity: 58, air: 80, drive: 10 }
    }
  };


  /* ------------------------------------------------------------------
   * 1.1 唱歌模式（K歌美声）
   *     对应原来的 6 个预设，但叠加"人声美化"处理：
   *       音准修正 + 人声加厚 + 齿音抑制 + 更适合唱歌的 EQ/压缩
   * ------------------------------------------------------------------ */

  // 唱歌模式下，每个风格对应的美化参数
  // 【2026-09-10 商用级重标定】依据全网调研（调研报告 9.5 节）：
  //   Auto-Tune Pro 业界标准：Retune Speed 自然=20~40ms / 商用流行=全幅拉正+中速过渡；
  //   Flex-Tune 30~50（唱得准就别动）；Humanize 25~50（长音保颤音）；
  //   旧版"按比例拉 55~62%"会残留走调 -> 商用级一律全幅拉正（corr≥0.75）
  var SING_CONFIG = {
    // correct  = 音准修正强度(%)  —— ≥75 才能达到商用级"完全拉正"
    // flex     = Flex-Tune 容差带(%) —— 30~50（业界推荐）
    // humanize = 长音人性化(%) —— 25~50（业界推荐）
    // retune   = 再调速度(%)      —— 0~25 慢(最自然) / 30~50 中(推荐) / 60~100 快(电音)
    'original': { correct: 80, thicken: 30, deEss: 35, formant: 85, retune: 32, flex: 45, humanize: 40, hp: 70,  low: 2,  high: 4,  comp: 0.62, gate: 0.012, reverb: { time: 0.55, decay: 1.9, mix: 0.20, damp: 0.50 }, pro: { warmth: 60, clarity: 66, air: 58, drive: 24 } },
    'smallroom':{ correct: 84, thicken: 38, deEss: 38, formant: 85, retune: 35, flex: 40, humanize: 35, hp: 75,  low: 3,  high: 4,  comp: 0.64, gate: 0.012, reverb: { time: 0.70, decay: 2.1, mix: 0.26, damp: 0.46 }, pro: { warmth: 64, clarity: 72, air: 62, drive: 34 } },
    'ktv':      { correct: 86, thicken: 50, deEss: 42, formant: 88, retune: 42, flex: 35, humanize: 30, hp: 80,  low: 4,  high: 5,  comp: 0.68, gate: 0.013, reverb: { time: 1.20, decay: 2.5, mix: 0.36, damp: 0.44 }, pro: { warmth: 70, clarity: 74, air: 58, drive: 40 } },
    'studio':   { correct: 90, thicken: 45, deEss: 50, formant: 90, retune: 38, flex: 30, humanize: 25, hp: 72,  low: 2,  high: 5,  comp: 0.70, gate: 0.015, reverb: { time: 0.38, decay: 1.4, mix: 0.16, damp: 0.70 }, pro: { warmth: 60, clarity: 80, air: 76, drive: 30 } },
    'theater':  { correct: 82, thicken: 42, deEss: 40, formant: 88, retune: 30, flex: 40, humanize: 35, hp: 85,  low: 1,  high: 3,  comp: 0.60, gate: 0.012, reverb: { time: 1.55, decay: 2.9, mix: 0.32, damp: 0.38 }, pro: { warmth: 52, clarity: 82, air: 55, drive: 26 } },
    'church':   { correct: 78, thicken: 35, deEss: 35, formant: 85, retune: 26, flex: 45, humanize: 40, hp: 90,  low: -1, high: 2,  comp: 0.55, gate: 0.011, reverb: { time: 2.5,  decay: 3.4, mix: 0.42, damp: 0.24 }, pro: { warmth: 45, clarity: 62, air: 85, drive: 16 } }
  };

  // 唱歌模式下的默认参数（用于展示）
  var SING_PRESETS = {};
  for (var k in PRESETS) {
    if (!PRESETS.hasOwnProperty(k)) continue;
    var base = PRESETS[k];
    var cfg = SING_CONFIG[k] || SING_CONFIG['original'];
    SING_PRESETS[k] = {
      name: base.name,
      premium: base.premium,
      desc: base.desc,
      reverb: cfg.reverb,
      hp: cfg.hp, low: cfg.low, high: cfg.high,
      comp: cfg.comp, gate: cfg.gate, notch: base.notch,
      pro: cfg.pro || (base.pro ? { warmth: base.pro.warmth, clarity: base.pro.clarity, air: base.pro.air, drive: base.pro.drive } : null),
      voice: {
        correct: cfg.correct / 100,
        thicken: cfg.thicken / 100,
        deEss: cfg.deEss / 100,
        formant: (cfg.formant != null ? cfg.formant : 85) / 100,
        retune: (cfg.retune != null ? cfg.retune : 30) / 100,
        flex: (cfg.flex != null ? cfg.flex : 40) / 100,
        humanize: (cfg.humanize != null ? cfg.humanize : 30) / 100
      }
    };
  }


  /* ------------------------------------------------------------------
   * 2. 程序化混响脉冲响应（IR）
   *    不引入任何外部音频素材 —— 用噪声 + 指数衰减 + 低通阻尼合成，
   *    再铺上几个早期反射，得到自然的房间感。
   * ------------------------------------------------------------------ */

  function makeImpulseResponse(ctx, seconds, decay, damp) {
    var sr = ctx.sampleRate;
    var len = Math.max(1, Math.floor(sr * seconds));
    var buf = ctx.createBuffer(2, len, sr);
    // 早期反射时间点（毫秒）与增益 —— 模拟房间墙面反射
    var early = [
      [11, 0.70], [17, 0.55], [23, 0.45], [31, 0.38],
      [43, 0.28], [57, 0.22], [73, 0.16], [97, 0.11]
    ];
    // 一阶低通阻尼系数：damp 越大越"闷"
    var lpCoef = Math.min(0.95, Math.max(0.05, damp));

    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var n = Math.random() * 2 - 1;
        // 指数衰减包络
        var env = Math.pow(1 - t, decay);
        // 阻尼低通（让高频先衰减，听感更自然）
        lp += (n - lp) * (1 - lpCoef);
        d[i] = lp * env;
      }
      // 叠加早期反射
      for (var e = 0; e < early.length; e++) {
        var idx = Math.floor(early[e][0] * sr / 1000);
        if (idx < len) {
          // 左右声道错开一点点，制造空间宽度
          var off = ch === 0 ? 0 : Math.floor(idx * 0.07);
          var at = idx + off;
          if (at < len) d[at] += early[e][1] * (ch === 0 ? 1 : 0.92);
        }
      }
      // 归一化，避免削顶
      var peak = 0;
      for (var k = 0; k < len; k++) { var a = d[k] < 0 ? -d[k] : d[k]; if (a > peak) peak = a; }
      if (peak > 0) {
        var g = 0.7 / peak;
        for (var m = 0; m < len; m++) d[m] *= g;
      }
    }
    return buf;
  }


  /* ------------------------------------------------------------------
   * 3. 主引擎
   * ------------------------------------------------------------------ */

  function MicEngine() {
    this.ctx = null;
    this.stream = null;
    this.nodes = {};
    this.workletReady = false;
    this.voiceReady = false;          // 人声美化 Worklet 是否就绪
    this.currentPreset = 'original';
    this.unlocked = false;
    this.running = false;
    this.sampleRate = RATE_HIGH;
    this.irCache = {};
    this.listeners = { state: [], level: [], howl: [], pitch: [] };
    this._meterRAF = null;
    this._pitchRAF = null;
    this._userGain = { vol: 70, reverb: -1, high: -1, low: -1, denoise: -1 };
    // 【2026-09-11 新增】环境噪声自动适配状态
    this._noiseProbes = [];        // worklet 每 0.5s 上报的底噪电平样本
    this._autoDenoiseDone = false; // 本次开麦已自动选过档（只自动一次）
    this._userDenoise = false;     // 用户手动调过降噪后自动适配永久让位
    // 唱歌模式
    this.singing = false;             // 是否处于唱歌模式
    // 注意：这里的初值必须与 SING_CONFIG['original'] 及 index.html 的滑块 value 保持一致，
    // 否则会出现"页面显示 30、引擎里是 35"的假象（用户不动滑块就永远不同步）。
    this._voiceFx = { correct: 55, thicken: 35, deEss: 40, formant: 85, retune: 30, flex: 40, humanize: 30 };   // 用户可调 0~100
    /* 【诉求② 专业美化链】2026-09-10 新增
     * 默认值依据全网调研的"专业人声预设"常见参数：
     *   warmth 50 = 不加不减（不预设染色，让用户按曲风选）
     *   clarity 60 = 轻微提亮（几乎所有人都受益，不易出错）
     *   air 55 = 轻微空气感
     *   drive 30 = 轻微饱和（"变厚但听不出加工"的临界点）
     */
    this._proFx = { warmth: 50, clarity: 60, air: 55, drive: 30 };
    this._proOn = false;          // 跟随唱歌模式，默认关
    this._proPreset = null;       // 当前专业预设 key
    /* 【2026-09-11 低延迟改造】
     * 延迟实测的最大来源之一是 getUserMedia 的 echoCancellation（回声消除）：
     * 安卓浏览器开 AEC 时系统要多缓存 100~200ms 做声学对齐，AGC 也有类似开销。
     * 但这两个只在【音箱外放】时才有用（防自己声音唱回去造成回授）；
     * 【戴耳机】时耳机不会漏音进麦克风，AEC 纯属白等。
     * 所以：lowLatency 默认开 = 关 AEC/AGC（省 100~200ms），
     *       noiseSuppression 保持开（硬件级波束成形，延迟极低，户外降噪还靠它）。
     * 用音箱外放的用户在 UI 上把"低延迟模式"关掉即可（会热切换重开一路麦）。
     */
    this.lowLatency = true;
    this.latencyMs = 0;           // ctx.baseLatency + outputLatency 的估算（毫秒）
    this._voiceOn = false;            // Worklet 是否已启用
    this._userTouchedVoice = false;   // 用户是否手动调过美化滑块
  }

  MicEngine.prototype.on = function (evt, fn) {
    /* 【2026-09-11 修复】旧写法 this.listeners[evt] 不存在时静默丢弃监听——
     * 新增事件名（如 micrevived）不在初始表里，UI 永远收不到通知。
     * 改成不存在就创建，任意事件名都能订阅。 */
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(fn);
    return this;
  };
  MicEngine.prototype._emit = function (evt, data) {
    var ls = this.listeners[evt] || [];
    for (var i = 0; i < ls.length; i++) { try { ls[i](data); } catch (e) {} }
  };

  /* --- 3.1 设备性能自检：返回建议采样率 + 是否告警 --- */
  MicEngine.prototype.detectPerformance = function () {
    var cores = navigator.hardwareConcurrency || 2;
    var mem = navigator.deviceMemory || 0;      // 仅部分浏览器支持
    var lowEnd = false;

    // 移动端 UA 粗判
    var ua = navigator.userAgent || '';
    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

    // 规则：核心数少 + 移动端 -> 降级
    if (cores <= 4 && isMobile) lowEnd = true;
    if (cores <= 2) lowEnd = true;
    if (mem && mem <= 2) lowEnd = true;

    // 记忆化：上次跑过卡顿的，继续用低采样率
    // 注意：无痕模式/禁用存储/非安全上下文下，裸访问 localStorage 会抛异常，
    //       必须用安全访问层包住（与 unlock.js 同样的处理）。
    var prev = 0;
    try {
      if (global.localStorage) {
        global.localStorage.getItem('mic_peak_load');
        prev = parseInt(global.localStorage.getItem('mic_peak_load') || '0', 10);
      }
    } catch (e) { prev = 0; }
    if (prev > 0) lowEnd = true;

    var rate = RATE_HIGH;
    if (lowEnd) rate = RATE_LOW;
    else if (cores <= 6 && isMobile) rate = RATE_MID;

    this.sampleRate = rate;
    return { lowEnd: lowEnd, rate: rate, cores: cores, isMobile: isMobile };
  };

  /* --- 3.2 启动 --- */
  MicEngine.prototype.start = function (opts) {
    var self = this;
    opts = opts || {};
    if (this.running) return Promise.resolve();

    var AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) return Promise.reject(new Error('浏览器不支持音频功能，请用 Chrome 或手机自带浏览器打开'));

    // 低延迟上下文（latencyHint: interactive）
    var ctxOpts = { latencyHint: 'interactive' };
    // 采样率自适应：只在浏览器支持时指定，不支持则由系统决定
    if (this.sampleRate && opts.forceRate !== false) {
      try { ctxOpts.sampleRate = this.sampleRate; } catch (e) {}
    }
    var ctx;
    try {
      ctx = new AudioCtx(ctxOpts);
    } catch (e) {
      try { ctx = new AudioCtx({ latencyHint: 'interactive' }); }
      catch (e2) { ctx = new AudioCtx(); }
    }
    this.ctx = ctx;
    try { this.watchCtxState(); } catch (e) {}   // iOS interrupted 自愈（2026-09-10 新增）

    // 【2026-09-11 延迟可视化】把设备固有的处理延迟算出来给 UI 显示，
    // 让老板/买家能分清"设备延迟"（这里显示的）和"蓝牙传输延迟"（约 200~500ms，软件管不了）。
    try {
      var bl = 0;
      if (ctx.baseLatency) bl += ctx.baseLatency;
      if (ctx.outputLatency) bl += ctx.outputLatency;
      this.latencyMs = Math.round(bl * 1000);
    } catch (e) { this.latencyMs = 0; }

    /* 请求麦克风。
     *
     * 【2026-09-10 修复·户外嘈杂音根因 A】
     * 旧代码把浏览器自带的三项处理全关了（noiseSuppression/echoCancellation/
     * autoGainControl = false），当时的理由是"怕和我们的算法打架"。
     * 但这是错的：手机上的 noiseSuppression 走的是【系统级/硬件级多麦克风波束成形】，
     * 它不是软件算法，而是直接调用手机第二/第三颗麦克风做方向性拾音——
     * 我们自己写的 JS 算法根本拿不到这个能力（浏览器只给一路混好的单声道）。
     * 户外场景下，关掉它等于自断一臂。
     *
     * 【2026-09-11 低延迟改造】
     * 实测延迟的最大来源是 echoCancellation（回声消除）：
     * 安卓浏览器开 AEC 时系统要多缓存 100~200ms 做声学对齐，AGC 也有类似开销。
     * AEC 只在【音箱外放】时有用（防止自己的声音被收回去造成回授）；
     * 【戴耳机】时耳机不漏音，AEC 纯属白等 100~200ms。
     * 所以拆成两档（见 _micConstraints）：
     *   低延迟模式（默认，戴耳机用）：关 AEC/AGC，保留硬件降噪
     *   外放模式（UI 可切）：全开，防回授，牺牲一点延迟
     */
    var constraints = this._micConstraints();

    return navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        self.stream = stream;
        /* 【2026-09-11 新增】蓝牙麦克风检测：
         * 蓝牙耳机/音箱当麦克风时走的是 HFP 通话协议（窄带 8~16kHz），
         * 底噪大、音质闷是协议固有的，软件救不了。检测到就发事件，
         * UI 如实提示"建议用手机自带麦克风或有线耳机"。 */
        try {
          var tr0 = stream.getAudioTracks && stream.getAudioTracks()[0];
          var lbl = ((tr0 && tr0.label) || '').toLowerCase();
          if (/bluetooth|蓝牙|wireless|无线/.test(lbl)) {
            setTimeout(function () { self._emit('state', { btMic: true, label: tr0.label }); }, 0);
          }
        } catch (e) {}
        return self._buildGraph(stream);
      })
      .then(function () {
        self.running = true;
        if (ctx.state === 'suspended') { ctx.resume(); }
        self._startMeter();
        /* 【诉求③ 后台/锁屏保活】开麦成功后立即启用：
         *   ① 申请屏幕常亮锁（阻止手机自动黑屏 = 阻止麦克风被系统收回）
         *   ② 建立媒体会话（提升后台存活优先级 + 锁屏显示信息）
         * 失败也不影响主功能，只是没享受到保活优势。 */
        try { self.enableKeepAlive(); } catch (e) {}
        self._emit('state', { running: true, latencyMs: self.latencyMs, lowLatency: self.lowLatency });
        return true;
      });
  };

  /* --- 3.2b 麦克风约束（低延迟模式可切换）【2026-09-11 新增】 --- */
  MicEngine.prototype._micConstraints = function () {
    var low = !!this.lowLatency;
    return {
      audio: {
        channelCount: 1,
        noiseSuppression: true,           // 硬件级波束成形，延迟极低，永远保留
        echoCancellation: !low,           // 低延迟=关（省 100~200ms），外放=开（防回授）
        autoGainControl: !low             // 同上；且 AGC 会压掉唱歌的强弱动态
      },
      video: false
    };
  };

  /**
   * 【2026-09-11 新增】把一路新的麦克风流热换到链路头上（共用底层）。
   * 低延迟模式切换和锁屏自愈都用这一条路径，保证行为一致：
   * 新流 connect 到链头 -> 旧 source disconnect -> 旧流 track 停掉 -> 换引用。
   */
  MicEngine.prototype._swapMicSource = function (ns) {
    var head = (this.workletReady && this.nodes.fx) ? this.nodes.fx : this.nodes.hp;
    if (!head) throw new Error('audio graph not ready');
    var newSrc = this.ctx.createMediaStreamSource(ns);
    newSrc.connect(head);
    try { if (this.nodes.src) this.nodes.src.disconnect(); } catch (e) {}
    try {
      if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {}
    this.stream = ns;
    this.nodes.src = newSrc;
  };

  /**
   * 【2026-09-11 新增】切换低延迟模式。
   * 没开麦时只记状态（下次 start() 生效）；
   * 已开麦时热切换：重新拿一路新约束的麦克风流换上去，不断图、不停表，
   * 用户只感觉到极短暂的一下（约 0.3~0.5 秒）。
   * 失败会回滚标志并抛错（旧流还在跑，不影响当前使用）。
   */
  MicEngine.prototype.setLowLatency = function (on) {
    var self = this;
    var want = !!on;
    if (want === this.lowLatency) return Promise.resolve(true);
    this.lowLatency = want;
    if (!this.running || !this.stream || !this.ctx || !this.nodes.src) {
      this._emit('state', { lowLatency: this.lowLatency });
      return Promise.resolve(true);
    }
    var constraints = this._micConstraints();
    return navigator.mediaDevices.getUserMedia(constraints).then(function (ns) {
      self._swapMicSource(ns);
      self._emit('state', { lowLatency: self.lowLatency });
      return true;
    }).catch(function (e) {
      self.lowLatency = !want;   // 回滚，旧流还在跑
      throw e;
    });
  };

  /**
   * 【2026-09-11 新增·锁屏自愈】回前台时体检麦克风，被系统掐死就自动换新流。
   *
   * 症状（老板实测）：安卓锁屏后回到页面，效果全没了。
   * 原因：锁屏瞬间系统把麦克风 track 掐死（readyState 变 ended / muted 卡死），
   *       回来后 AudioContext 能 resume，但那路已死的流永远不会再出声——
   *       旧代码只 resume 了上下文，没恢复麦克风，所以"回来还是没声音"。
   * 正解：visibilitychange 回前台时做三步——
   *   ① resume 音频上下文 ② 等 600ms（给浏览器切回前台的时间）
   *   ③ 体检 track：死了就重新 getUserMedia（权限已授过，不弹窗）热换新流。
   * 恢复成功发 'micrevived' 事件，UI 提示"已自动恢复"。
   */
  MicEngine.prototype._micAlive = function () {
    var t = this.stream && this.stream.getAudioTracks && this.stream.getAudioTracks()[0];
    return !!t && t.readyState === 'live' && !t.muted;
  };

  MicEngine.prototype.reviveMicIfNeeded = function () {
    var self = this;
    if (!this.running || !this.ctx || !navigator.mediaDevices) {
      return Promise.resolve(false);
    }
    var needCtx = this.ctx.state === 'suspended';
    var p = needCtx ? this.ctx.resume().catch(function () {}) : Promise.resolve();
    return p.then(function () {
      // 给浏览器一点时间把设备切回前台（立刻查会误判）
      return new Promise(function (res) { setTimeout(res, needCtx ? 600 : 350); });
    }).then(function () {
      if (self._micAlive()) return false;   // 没死，什么都不用做
      return navigator.mediaDevices.getUserMedia(self._micConstraints())
        .then(function (ns) {
          self._swapMicSource(ns);
          self._emit('micrevived', { reason: 'lock-or-background' });
          return true;
        })
        .catch(function () { return false; });   // 拿不到（权限被收走等）：保持现状不炸
    });
  };

  /* --- 3.3 搭建音频图 --- */
  MicEngine.prototype._buildGraph = function (stream) {
    var self = this;
    var ctx = this.ctx;

    var src = ctx.createMediaStreamSource(stream);

    // (a) AudioWorklet：降噪门 + 反馈抑制
    var workletPromise = Promise.resolve();
    if (ctx.audioWorklet) {
      var blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      workletPromise = ctx.audioWorklet.addModule(url)
        .then(function () {
          self.nodes.fx = new AudioWorkletNode(ctx, 'mic-fx', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { gateThreshold: 0.010, notchEnabled: false }
          });
          // 【2026-09-11 新增】接收 worklet 的环境噪声电平探测（noiseProbe），
          // 用于开麦几秒后自动选降噪档位（真麦克风的自适应降噪思路）
          self.nodes.fx.port.onmessage = function (e) {
            var d = e && e.data;
            if (d && d.type === 'noiseProbe' && typeof d.v === 'number') {
              try { self._onNoiseProbe(d.v); } catch (er) {}
            }
          };
          self.workletReady = true;
        })
        .catch(function () { self.workletReady = false; })
        .then(function () { try { URL.revokeObjectURL(url); } catch (e) {} });

      // (a2) 人声美化 Worklet（唱歌模式用：音准修正 + 加厚 + 齿音抑制）
      //      单独 addModule，失败不影响主链路
      if (global.VOICE_FX_SRC) {
        var vblob = new Blob([global.VOICE_FX_SRC], { type: 'application/javascript' });
        var vurl = URL.createObjectURL(vblob);
        workletPromise = workletPromise.then(function () {
          return ctx.audioWorklet.addModule(vurl)
            .then(function () {
              self.nodes.voice = new AudioWorkletNode(ctx, 'voice-fx', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: {
                  enabled: false,            // 默认关闭，进唱歌模式才开
                  correctAmt: self._voiceFx.correct / 100,
                  thickenAmt: self._voiceFx.thicken / 100,
                  deEssAmt: self._voiceFx.deEss / 100,
                  formantAmt: (self._voiceFx.formant != null ? self._voiceFx.formant : 85) / 100,
                  retune: (self._voiceFx.retune != null ? self._voiceFx.retune : 30) / 100,
                  flex: (self._voiceFx.flex != null ? self._voiceFx.flex : 40) / 100,
                  humanize: (self._voiceFx.humanize != null ? self._voiceFx.humanize : 30) / 100
                }
              });
              // 自检上报：如果"音色保持"整块一个样本都没贴上，
              // worklet 会发 formant-dead。这里暴露出来，避免又变成静默失效。
              self.nodes.voice.port.onmessage = function (e) {
                var d = e && e.data;
                if (d && d.type === 'formant-dead') {
                  self.voiceFxDead = true;
                  try { self._emit('voicefx-dead', { fail: d.fail }); } catch (er) {}
                }
              };
              self.voiceReady = true;
            })
            .catch(function () { self.voiceReady = false; })
            .then(function () { try { URL.revokeObjectURL(vurl); } catch (e) {} });
        });
      }
    }

    return workletPromise.then(function () {
      // (b) 低切滤波：滤掉风声与低频隆隆声
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 80;
      hp.Q.value = 0.707;

      // (c) 低音 / 高音 搁架 EQ
      var low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 250;
      low.gain.value = 0;

      var high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 3200;
      high.gain.value = 0;

      // (d) 压缩器：防止大声破音，稳定音量
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -22;
      comp.knee.value = 24;
      comp.ratio.value = 3.2;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;

      // (e) 干湿分离：干声 + 混响
      var dry = ctx.createGain();   dry.gain.value = 1;
      var wetIn = ctx.createGain(); wetIn.gain.value = 0;
      var conv = ctx.createConvolver();
      var wetOut = ctx.createGain(); wetOut.gain.value = 1;

      // (f) 总音量（软件增益，相当于简易功放）
      var master = ctx.createGain(); master.gain.value = 0.7;

      // (g) 输出保护：再放一级限幅，避免啸叫时炸耳朵
      var limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.06;

      var analyser = ctx.createAnalyser();
      // 注意：fftSize 必须 >= 2048。
      // 音高检测需要 2048 个时域样本（低音 70Hz 的周期就有 630 个样本，
      // 至少要两个完整周期才判得准）。若 fftSize 偏小，
      // getFloatTimeDomainData 只会写前 fftSize 个，剩下的全是 0，
      // 自相关会把 0 段当成完全相关 -> 低音被报成 1100Hz。
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;

      // ---- 连接 ----
      var head = src;
      if (self.workletReady && self.nodes.fx) {
        src.connect(self.nodes.fx);
        head = self.nodes.fx;
      }
      head.connect(hp);
      hp.connect(low);
      low.connect(high);
      high.connect(comp);

      // 人声美化节点（唱歌模式）：串在压缩之后、混响之前
      var tail = comp;
      if (self.voiceReady && self.nodes.voice) {
        comp.connect(self.nodes.voice);
        tail = self.nodes.voice;
      }

      /* ========================================================================
       * 【2026-09-10 新增·诉求② 专业歌手级美化链】
       * ------------------------------------------------------------------------
       * 背景：全网调研了专业录音棚的人声处理链（Waves / UAD / FabFilter /
       * iZotope 的标准做法），标准顺序是：
       *   ① 纠正性 EQ（切低频隆隆、切房间共振、切鼻音）
       *   ② 第一级压缩（opto 风格，慢，3~4dB）
       *   ③ 音色 EQ（温暖 + 临场感 + 空气感）   <-- 本次补的就是这一段
       *   ④ 去齿音
       *   ⑤ 第二级压缩（FET/VCA，快）
       *   ⑥ 谐波饱和 / 磁带染色                 <-- 本次补的
       *   ⑦ 混响 / 延时
       *
       * 已有什么：音准修正、共振峰保持、去齿音、两级压缩、板混响
       * 缺什么（本次补齐）：临场感 EQ、空气感 EQ、谐波饱和、
       *                    动态 EQ 去浑浊 / 去鼻音
       *
       * 【为什么插在 voice 之后而不是重排整条链】
       *   重排已验证的链路风险高（本项目踩过"改了链路但没验证"的坑）。
       *   而"音色 EQ + 饱和"本来就应该在人声处理的中后段，
       *   插在 voice（含音准/共振峰/压缩）之后、混响之前，
       *   正好就是专业链第 ③~⑥ 步的正确位置 —— 位置是对的，不用重排。
       *
       * 频率选择依据（人声工程共识）：
       *   200~500Hz  "浑浊区"(mud)：堆积会让人声发闷、像捂着被子
       *   800Hz~1.2kHz "鼻音区"(nasal/honk)：多了像鼻塞
       *   150~250Hz  温暖区(warmth)：人声"厚度"来源，加 2~3dB 显磁性
       *   2~5kHz     临场感区(presence)：咬字清晰度、"贴脸感"来源
       *   10~16kHz   空气感区(air)：泛音光泽、"高级感"来源
       * ====================================================================== */

      // ③-a 温暖感：150Hz lowshelf，给人声加"厚度/磁性"
      var warmth = ctx.createBiquadFilter();
      warmth.type = 'lowshelf';
      warmth.frequency.value = 180;
      warmth.gain.value = 0;      // 由 setWarmth 控制，默认 0（不染色）

      // ③-b 去浑浊：350Hz peaking 负增益，切掉"捂着"的闷感
      var mud = ctx.createBiquadFilter();
      mud.type = 'peaking';
      mud.frequency.value = 320;
      mud.Q.value = 1.1;
      mud.gain.value = 0;

      // ③-c 去鼻音：1kHz peaking 负增益，切掉"感冒"的鼻音
      var nasal = ctx.createBiquadFilter();
      nasal.type = 'peaking';
      nasal.frequency.value = 1000;
      nasal.Q.value = 1.4;
      nasal.gain.value = 0;

      // ③-d 临场感：3.2kHz peaking 正增益，"贴脸感"和咬字清晰度
      var presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3200;
      presence.Q.value = 0.9;
      presence.gain.value = 0;

      // ③-e 空气感：12kHz highshelf 正增益，泛音光泽
      var air = ctx.createBiquadFilter();
      air.type = 'highshelf';
      air.frequency.value = 12000;
      air.gain.value = 0;

      /* ⑥ 谐波饱和（激励器）：人声"专业感"的最大来源之一。
       * 原理：把波形轻微"压扁"（软削波），产生人声原本没有的偶次/奇次谐波。
       *   偶次谐波(2f/4f...)  -> 听感"温暖、厚实、类电子管"
       *   奇次谐波(3f/5f...)  -> 听感"明亮、有力、类晶体管"
       * 实现：WaveShaperNode + tanh 曲线（软饱和，无硬拐点，不会刺耳）。
       *
       * 【为什么必须加"干湿混合"】
       *   纯饱和会把干净人声染色过重，听起来"糊"。专业做法是并联：
       *   干声 + 少量饱和声混合（通常饱和只占 15~35%）。
       *   所以这里做的是 dry/wet 并联结构：satDry + satIn->shaper->satWet。
       *
       * 采样率注意：WaveShaper 的 oversample='4x' 做 4 倍过采样，
       *   避免饱和产生的高频折叠回可听频段（aliasing）造成"沙沙"数字味。
       */
      var satIn = ctx.createGain();   satIn.gain.value = 0;   // 0 = 不推饱和
      var shaper = ctx.createWaveShaper();
      shaper.curve = self._makeSaturationCurve(2.2);
      shaper.oversample = '4x';
      var satWet = ctx.createGain();  satWet.gain.value = 0.0;
      var satDry = ctx.createGain();  satDry.gain.value = 1.0;
      var proOut = ctx.createGain();  proOut.gain.value = 1.0;

      tail.connect(warmth);
      warmth.connect(mud);
      mud.connect(nasal);
      nasal.connect(presence);
      presence.connect(air);

      // 空气感之后分两路：一路干声直通，一路进饱和
      air.connect(satDry);
      air.connect(satIn);
      satIn.connect(shaper);
      shaper.connect(satWet);
      satDry.connect(proOut);
      satWet.connect(proOut);

      // 专业链的最末端（proOut）替代原来的 tail，接去混响
      tail = proOut;

      tail.connect(dry);      // 干声直通
      tail.connect(wetIn);    // 送去混响
      wetIn.connect(conv);

      /* 【2026-09-11 新增·行业标准】混响返回通道必须切频：
       * 专业混音的共识做法（audiomixingmastering / violetrecording）：
       *   - 返回通道高通 300~500Hz：混响里的低频只会糊成一团，切掉人声才"立得住"
       *   - 返回通道低通 ~10kHz：混响高频留太多会"沙沙"发毛
       * 这一步是"丝滑感"的关键之一——混响负责空间，不抢人声的清晰度。 */
      var wetHP = ctx.createBiquadFilter();
      wetHP.type = 'highpass';
      wetHP.frequency.value = 300;
      wetHP.Q.value = 0.707;
      var wetLP = ctx.createBiquadFilter();
      wetLP.type = 'lowpass';
      wetLP.frequency.value = 9000;
      conv.connect(wetHP);
      wetHP.connect(wetLP);
      wetLP.connect(wetOut);

      dry.connect(master);
      wetOut.connect(master);
      master.connect(limiter);
      limiter.connect(analyser);
      analyser.connect(ctx.destination);

      self.nodes = Object.assign(self.nodes, {
        src: src, hp: hp, low: low, high: high, comp: comp,
        dry: dry, wetIn: wetIn, conv: conv, wetOut: wetOut,
        master: master, limiter: limiter, analyser: analyser,
        // 专业美化链（诉求②）
        warmth: warmth, mud: mud, nasal: nasal, presence: presence, air: air,
        satIn: satIn, shaper: shaper, satWet: satWet, satDry: satDry, proOut: proOut,
        // 混响返回切频（2026-09-11）
        wetHP: wetHP, wetLP: wetLP
      });

      // 应用当前预设
      self._applyPreset(self.currentPreset, true);

      // Worklet 刚就绪：如果用户之前已经选了唱歌模式，这里补上开关状态。
      // 否则会出现"先点唱歌模式、再开麦"时美化没生效的问题。
      if (self.singing && self.voiceReady) self._voiceOn = true;
      self._pushVoiceParams();
      self._emit('state', { singing: self.singing, voiceReady: self.voiceReady });
    });
  };

  /* --- 3.3b 把人声美化参数推给 Worklet --- */
  MicEngine.prototype._pushVoiceParams = function () {
    if (!this.voiceReady || !this.nodes.voice) return;
    try {
      this.nodes.voice.port.postMessage({
        type: 'params',
        enabled: !!this._voiceOn,
        correctAmt: this._voiceFx.correct / 100,
        thickenAmt: this._voiceFx.thicken / 100,
        deEssAmt: this._voiceFx.deEss / 100,
        // 共振峰保持：移调后把原始"音色"贴回去，消除花栗鼠/怪兽音。
        // 0 = 关闭（音色跟着音高跑），1 = 完全保持（推荐 0.85）
        formantAmt: this._voiceFx.formant != null ? this._voiceFx.formant / 100 : 0.85,
        // 再调速度（对应 Auto-Tune 的 Retune Speed）：
        // 0 = 最慢最自然（保留滑音），1 = 最快（电音感）
        retune: this._voiceFx.retune != null ? this._voiceFx.retune / 100 : 0.30,
        // 【2026-09-10 商用级】Flex-Tune 容差带 + 长音人性化
        flex: (this._voiceFx.flex != null ? this._voiceFx.flex : 40) / 100,
        humanize: (this._voiceFx.humanize != null ? this._voiceFx.humanize : 30) / 100
      });
    } catch (e) {}
  };

  /* --- 3.4 混响 IR（带缓存，避免重复计算） --- */
  MicEngine.prototype._getIR = function (time, decay, damp) {
    var key = time.toFixed(2) + '_' + decay.toFixed(2) + '_' + damp.toFixed(2);
    if (this.irCache[key]) return this.irCache[key];
    var ir = makeImpulseResponse(this.ctx, time, decay, damp);
    this.irCache[key] = ir;
    // 缓存上限，防内存膨胀
    var keys = Object.keys(this.irCache);
    if (keys.length > 12) { delete this.irCache[keys[0]]; }
    return ir;
  };

  /* --- 3.5 切换预设 --- */
  MicEngine.prototype.setPreset = function (key) {
    var p = PRESETS[key];
    if (!p) return false;
    if (p.premium && !this.unlocked) return false;
    this.currentPreset = key;
    this._userGain.reverb = -1;   // 切预设时清掉用户自定义混响，跟随预设
    this._applyPreset(key, false);
    this._emit('state', { preset: key });
    return true;
  };

  MicEngine.prototype._applyPreset = function (key, initial) {
    // 唱歌模式用唱歌版参数，说话模式用原参数
    var p = (this.singing && SING_PRESETS[key]) ? SING_PRESETS[key] : PRESETS[key];
    if (!p) return;
    var n = this.nodes;
    if (!n.hp) return;
    var now = this.ctx.currentTime;
    var RAMP = 0.06;

    function ramp(param, val) {
      if (!param) return;
      try { param.setTargetAtTime(val, now, RAMP); }
      catch (e) { param.value = val; }
    }

    ramp(n.hp.frequency, p.hp);
    ramp(n.low.gain, p.low);
    ramp(n.high.gain, p.high);
    ramp(n.comp.threshold, -14 - p.comp * 18);
    ramp(n.comp.ratio, 2 + p.comp * 3);

    // 混响
    if (p.reverb.time > 0.01) {
      var ir = this._getIR(p.reverb.time, p.reverb.decay, p.reverb.damp);
      if (n.conv.buffer !== ir) n.conv.buffer = ir;
      ramp(n.wetIn.gain, p.reverb.mix);
      this._wetBase = p.reverb.mix;
    } else {
      ramp(n.wetIn.gain, 0);
      this._wetBase = 0;
    }

    // 【2026-09-11 专业链接入预设】切预设时把该风格的专业 EQ/饱和也一并套上。
    // 这是"切音效变化不大"的根因修复：之前这 5 个专业节点永远是 0，
    // 切预设只有混响在变。现在预设带 pro 参数，切一下立刻听出风格差异。
    // 用 silent 模式调用（不动 _userTouchedPro），用户之后手动拖滑块仍可自由覆盖，
    // 直到下次切预设再跟随预设。
    if (p.pro && this.nodes.proOut) {
      this._proFx.warmth  = p.pro.warmth;
      this._proFx.clarity = p.pro.clarity;
      this._proFx.air     = p.pro.air;
      this._proFx.drive   = p.pro.drive;
      this.setWarmth(p.pro.warmth, true);
      this.setClarity(p.pro.clarity, true);
      this.setAir(p.pro.air, true);
      this.setDrive(p.pro.drive, true);
      this._emit('state', { proFx: {
        warmth: p.pro.warmth, clarity: p.pro.clarity,
        air: p.pro.air, drive: p.pro.drive
      } });
    }

    // 降噪门限 & 反馈抑制开关
    this._setGate(p.gate);
    this._setNotch(!!p.notch);

    // 唱歌模式：把该风格的美化参数同步给 Worklet（用户手动调过则以用户值为准）
    if (this.singing && p.voice && !this._userTouchedVoice) {
      this._voiceFx.correct = Math.round(p.voice.correct * 100);
      this._voiceFx.thicken = Math.round(p.voice.thicken * 100);
      this._voiceFx.deEss   = Math.round(p.voice.deEss * 100);
      if (p.voice.formant != null) this._voiceFx.formant = Math.round(p.voice.formant * 100);
      if (p.voice.retune  != null) this._voiceFx.retune  = Math.round(p.voice.retune  * 100);
      if (p.voice.flex     != null) this._voiceFx.flex     = Math.round(p.voice.flex * 100);
      if (p.voice.humanize != null) this._voiceFx.humanize = Math.round(p.voice.humanize * 100);
      this._pushVoiceParams();
      this._emit('state', { voiceFx: {
        correct: this._voiceFx.correct,
        thicken: this._voiceFx.thicken,
        deEss: this._voiceFx.deEss
      } });
    }
  };

  MicEngine.prototype._setGate = function (th) {
    if (this.workletReady && this.nodes.fx) {
      this.nodes.fx.port.postMessage({ type: 'params', gateThreshold: th });
    } else if (this.nodes.comp) {
      // 没有 Worklet 时的降级方案：用压缩器模拟轻降噪
      try { this.nodes.comp.threshold.setTargetAtTime(-24 - th * 400, this.ctx.currentTime, 0.1); } catch (e) {}
    }
  };

  MicEngine.prototype._setNotch = function (on) {
    if (this.workletReady && this.nodes.fx) {
      this.nodes.fx.port.postMessage({ type: 'params', notchEnabled: !!on });
    }
  };

  /* --- 3.6 用户滑块：0~100 --- */
  MicEngine.prototype.setVolume = function (v) {
    this._userGain.vol = v;
    var g = Math.pow(Math.max(0, Math.min(100, v)) / 70, 1.4);
    if (this.nodes.master) {
      try { this.nodes.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05); }
      catch (e) { this.nodes.master.gain.value = g; }
    }
  };

  MicEngine.prototype.setReverb = function (v) {
    this._userGain.reverb = v;
    if (!this.nodes.wetIn) return;
    var base = this._wetBase != null ? this._wetBase : 0;
    // base=0（原声）时，滑块也能加一点混响，让用户有得调
    var mix = (base > 0 ? base : 0.10) * (Math.max(0, Math.min(100, v)) / 60);
    mix = Math.min(0.6, mix);
    try { this.nodes.wetIn.gain.setTargetAtTime(mix, this.ctx.currentTime, 0.05); }
    catch (e) { this.nodes.wetIn.gain.value = mix; }
  };

  MicEngine.prototype.setHigh = function (v) {
    this._userGain.high = v;
    if (!this.nodes.high) return;
    var g = (Math.max(0, Math.min(100, v)) - 50) / 50 * 9;  // -9 ~ +9 dB
    if (this.sampleRate <= RATE_LOW) g *= 0.7;
    try { this.nodes.high.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05); }
    catch (e) { this.nodes.high.gain.value = g; }
  };

  MicEngine.prototype.setLow = function (v) {
    this._userGain.low = v;
    if (!this.nodes.low) return;
    var g = (Math.max(0, Math.min(100, v)) - 50) / 50 * 9;  // -9 ~ +9 dB
    // 低切之后再加低频，容易糊 + 易啸叫，做一点保护
    if (g > 0) g *= 0.8;
    try { this.nodes.low.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05); }
    catch (e) { this.nodes.low.gain.value = g; }
  };

  /* --- 降噪场景档位（2026-09-10 新增·对接老板"户外唱歌"诉求）---
   *
   * 每个档位同时决定三件事：
   *   denoise  = 谱减法降噪强度（0~100，主力）
   *   gate     = 安静时的门限补刀高度（0~100）
   *   hw       = 是否建议开启手机硬件降噪/回声消除/AGC（部分场景关掉更好）
   *
   * 设计依据：
   *   - 室内安静：只轻降噪，避免过度处理让人声发闷
   *   - 户外/人群："强"档，谱减开到 78，配合手机双麦硬件降噪
   *   - KTV包间/车里：中强，重点压稳态低频轰鸣（空调/引擎）
   *   - 舞台/空旷：中档，因为空旷地几乎没有反射噪声，降太狠反而丢细节
   */
  var DENOISE_SCENES = {
    indoor:  { name: '室内安静',   denoise: 22, gate: 30, hint: '家里、卧室、安静房间' },
    outdoor: { name: '户外/人群',  denoise: 82, gate: 62, hint: '马路边、广场、有人的地方（推荐强档）' },
    ktv:     { name: 'KTV/车里',   denoise: 68, gate: 52, hint: '包间、车内，有空调/引擎轰鸣' },
    stage:   { name: '舞台/空旷',  denoise: 45, gate: 40, hint: '舞台、空旷场地，几乎没有反射噪声' },
    off:     { name: '不降噪',     denoise: 0,  gate: 12, hint: '只要原声，不做任何降噪' }
  };

  MicEngine.prototype.setDenoise = function (v) {
    this._userGain.denoise = v;    var vv = Math.max(0, Math.min(100, v)) / 100;
    // (a) 噪声门：安静时压残余底噪（0 到 100 -> 门限 0.0015 ~ 0.0465）
    var th = 0.0015 + vv * 0.045;
    this._setGate(th);
    // (b) 谱减法降噪：唱歌时也持续工作（这才是户外嘈杂的主力）
    //     用户"降噪强度"直接映射谱减量，非线性映射让 30~70 段更好调
    var amt = Math.pow(vv, 0.85);
    this._setDenoiseAmt(amt);
  };

  MicEngine.prototype._setDenoiseAmt = function (amt) {
    this._denoiseAmt = amt;
    if (this.workletReady && this.nodes.fx) {
      this.nodes.fx.port.postMessage({ type: 'params', denoiseAmt: amt });
    }
  };

  /* 一键切换降噪场景（UI 上做成按钮，标书小白用户不用理解数值） */
  MicEngine.prototype.setDenoiseScene = function (key) {
    var sc = DENOISE_SCENES[key];
    if (!sc) return null;
    this._scene = key;
    if (sc.denoise <= 0) {
      // 「不降噪」档：连谱减也停，但保留轻微门限防啸叫底噪
      this._setDenoiseAmt(0);
      this._setGate(0.0015 + (sc.gate / 100) * 0.045);
    } else {
      this.setDenoise(sc.denoise);
    }
    this._emit('state', { scene: key, sceneName: sc.name });
    return sc;
  };

  /* 换场地时重新学一遍环境噪声底（谱减法会因为场地变了而需要重学） */
  MicEngine.prototype.resetNoiseFloor = function () {
    if (this.workletReady && this.nodes.fx) {
      this.nodes.fx.port.postMessage({ type: 'resetNoise' });
    }
  };

  /* ================================================================
   * 【2026-09-11 新增】环境噪声自动适配（真麦克风/会议软件的思路）
   *
   * 老板反馈"一开麦杂音太大"的根因之一：最强降噪档埋在场景按钮里，
   * 小白用户不会主动点，默认降噪 35/100 实际只压约 20% 环境噪声。
   *
   * 现在：worklet 每 0.5s 上报一次"窗口内最安静的电平"（底噪），
   * 开麦约 3 秒后取中位数自动选场景档位。用户手动调过降噪就不自动。
   * ================================================================ */
  MicEngine.prototype._onNoiseProbe = function (v) {
    if (!this.running) return;
    this._noiseProbes.push(v);
    if (this._noiseProbes.length > 12) this._noiseProbes.shift();
    if (this._autoDenoiseDone || this._userDenoise) return;
    if (this._noiseProbes.length < 6) return;   // 开麦约 3 秒再判断
    // 取中位数：抗个别异常帧（比如刚好有人拍了一下手）
    var arr = this._noiseProbes.slice().sort(function (a, b) { return a - b; });
    var mid = arr[Math.floor(arr.length / 2)];
    // 分档阈值（env 是绝对幅度包络，实测标定）：
    //   安静室内 < 0.005；有空调/人声背景 0.005~0.009；
    //   明显嘈杂（电视/街道远） 0.009~0.02；户外人群 > 0.02
    var key;
    if      (mid > 0.020) key = 'outdoor';
    else if (mid > 0.009) key = 'ktv';
    else if (mid > 0.005) key = 'stage';
    else                  key = 'indoor';
    this._autoDenoiseDone = true;
    this.setDenoiseScene(key);
    this._emit('state', { autoDenoise: true, scene: key, level: mid });
  };

  /* 用户手动调过降噪（点场景/拖滑块）之后，自动适配永久让位 */
  MicEngine.prototype.markUserDenoise = function () {
    this._userDenoise = true;
  };

  MicEngine.prototype.getDenoiseScenes = function () { return DENOISE_SCENES; };

  /* --- 3.7 电平表（用于 UI 提示，不做录音） --- */
  MicEngine.prototype._startMeter = function () {
    var self = this;
    if (!this.nodes.analyser) return;
    var buf = new Uint8Array(this.nodes.analyser.frequencyBinCount);
    var stop = false;
    this._meterStop = function () { stop = true; };

    function tick() {
      if (stop || !self.nodes.analyser) return;
      self.nodes.analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var d = (buf[i] - 128) / 128;
        sum += d * d;
      }
      var rms = Math.sqrt(sum / buf.length);
      self._emit('level', rms);
      self._meterRAF = requestAnimationFrame(tick);
    }
    tick();
  };

  /* --- 3.8 停止 --- */
  MicEngine.prototype.stop = function () {
    if (this._meterStop) this._meterStop();
    if (this._meterRAF) cancelAnimationFrame(this._meterRAF);
    this._stopPitchMeter();
    // 【2026-09-11】关麦后重置噪声探测状态：下次开麦重新检测环境
    // （_userDenoise 保留——用户手动调过的偏好跨开关麦生效）
    this._noiseProbes = [];
    this._autoDenoiseDone = false;
    /* 【诉求③】关麦时释放屏幕常亮锁 + 清理媒体会话，
     * 把系统资源还给用户（不释放的话屏幕会一直亮着耗电）。 */
    try { this.disableKeepAlive(); } catch (e) {}
    if (this.nodes.src) { try { this.nodes.src.disconnect(); } catch (e) {} }
    if (this.stream) {
      var tracks = this.stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      this.stream = null;
    }
    if (this.ctx && this.ctx.state === 'running') { try { this.ctx.suspend(); } catch (e) {} }
    this.running = false;
    this._emit('state', { running: false });
  };

  MicEngine.prototype.destroy = function () {
    this.stop();
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
  };

  /* --- 3.9 解锁 --- */
  MicEngine.prototype.setUnlocked = function (v) {
    this.unlocked = !!v;
    this._emit('state', { unlocked: this.unlocked });
  };

  /* ==================================================================
   * 3.10 唱歌模式（K歌美声）
   * ================================================================== */

  /**
   * 切换唱歌模式。
   *   on = true  -> 开启人声美化（音准修正/加厚/齿音），并套用唱歌版预设参数
   *   on = false -> 关闭美化，恢复说话版预设参数
   *
   * 返回值语义很重要：
   *   - 返回 false 只表示"当前这一刻 Worklet 还没就绪"，不代表设备不支持。
   *   - Worklet 是在开麦时才异步加载的，所以用户在开麦前先点"唱歌模式"时，
   *     voiceReady 必然是 false。此时不能跟用户说"本机不支持实时修音"，
   *     因为等他点了开麦，Worklet 就绪后美化会自动接上。
   *   - 因此这里返回的是"用户想不想开"（intent），而不是"此刻开没开"。
   *     真正的生效状态看 getVoiceFx().on。
   */
  MicEngine.prototype.setSinging = function (on) {
    this.singing = !!on;
    this._voiceOn = !!on && this.voiceReady;

    // 切模式时，把预设按对应版本重新应用一次
    this._applyPreset(this.currentPreset, false);
    this._pushVoiceParams();

    /* 【诉求② 专业美化链联动】2026-09-10
     * 专业链（临场感/空气感/饱和等）只在唱歌模式生效。
     * 不唱歌时（比如当话筒喊话）保持完全旁路，
     * 避免染色让说话声变得不自然。 */
    this.setProChain(!!on);

    // 唱歌模式下打开音高显示
    if (this.singing) this._startPitchMeter();
    else this._stopPitchMeter();

    this._emit('state', { singing: this.singing, voiceReady: this.voiceReady });
    // 返回"意图"：只要用户要开唱歌模式就返回 true
    return !!on;
  };

  /** 音准修正强度 0~100 */
  MicEngine.prototype.setPitchCorrect = function (v) {
    this._userTouchedVoice = true;
    this._voiceFx.correct = Math.max(0, Math.min(100, v));
    this._pushVoiceParams();
  };

  /** 人声加厚强度 0~100 */
  MicEngine.prototype.setThicken = function (v) {
    this._userTouchedVoice = true;
    this._voiceFx.thicken = Math.max(0, Math.min(100, v));
    this._pushVoiceParams();
  };

  /** 齿音抑制强度 0~100 */
  MicEngine.prototype.setDeEss = function (v) {
    this._userTouchedVoice = true;
    this._voiceFx.deEss = Math.max(0, Math.min(100, v));
    this._pushVoiceParams();
  };

  /**
   * 共振峰保持强度 0~100（默认 85）
   * 作用：移调后把原始"音色/共鸣"贴回去。
   *   0   = 关闭（音高变了、音色也跟着变 -> 花栗鼠/怪兽音）
   *   85  = 推荐（音高变了、音色基本不变 -> 还是"你的声音"）
   *   100 = 最强保持
   */
  MicEngine.prototype.setFormant = function (v) {
    this._userTouchedVoice = true;
    this._voiceFx.formant = Math.max(0, Math.min(100, v));
    this._pushVoiceParams();
  };

  /**
   * 再调速度 0~100（默认 35）—— 对应专业软件里的 Retune Speed
   *   0~25  慢：像人声滑音，完全听不出修过（适合民谣/抒情）
   *   30~50 中：轻微吸附，自然（推荐，默认 35）
   *   60~100 快：瞬间吸附到音准，出现"电音感"（适合舞曲/说唱/刻意效果）
   */
  MicEngine.prototype.setRetune = function (v) {
    this._userTouchedVoice = true;
    this._voiceFx.retune = Math.max(0, Math.min(100, v));
    this._pushVoiceParams();
  };

  /** 读取当前美化参数（给 UI 同步用） */
  MicEngine.prototype.getVoiceFx = function () {
    return {
      correct: this._voiceFx.correct,
      thicken: this._voiceFx.thicken,
      deEss: this._voiceFx.deEss,
      formant: this._voiceFx.formant != null ? this._voiceFx.formant : 85,
      retune: this._voiceFx.retune != null ? this._voiceFx.retune : 30,
      flex: this._voiceFx.flex != null ? this._voiceFx.flex : 40,
      humanize: this._voiceFx.humanize != null ? this._voiceFx.humanize : 30,
      /* 专业链新增 5 项（诉求② 2026-09-10） */
      warmth:   this._proFx.warmth,
      clarity:  this._proFx.clarity,
      air:      this._proFx.air,
      drive:    this._proFx.drive,
      proOn:    this._proOn,
      on: this._voiceOn,
      ready: this.voiceReady
    };
  };

  /* ==========================================================================
   * 【诉求② 专业歌手级美化链】2026-09-10 新增
   * --------------------------------------------------------------------------
   * 这是对上面 5 个 setter 的补充，补齐全网调研中"专业录音棚人声链"里
   * 我们缺失的 4 个环节：音色 EQ（温暖/临场感/空气感）+ 谐波饱和。
   *
   * 与已有 5 项的分工：
   *   已有（voice worklet 内）：音准修正、共振峰保持、去齿音、压缩、厚度
   *   新增（本段）：温暖感 lowshelf、去浑浊、去鼻音、临场感、空气感、饱和
   * ======================================================================== */

  /**
   * 生成谐波饱和曲线（tanh 软削波）
   * 为什么用 tanh 而不是硬削波：
   *   硬削波（clip）在拐点处导数不连续，会产生大量高次奇次谐波，
   *   听感"刺耳、毛躁、像坏了"。tanh 处处可导，谐波衰减快，
   *   听感"温暖、自然、像电子管"。这是专业饱和插件（如 Soundtoys
   *   Decapitator、FabFilter Saturn）的通用做法。
   *
   * 【归一化方式·2026-09-10 修正·很关键】
   *   第一版写成 curve = tanh(k*x) / tanh(k)（把 ±1 端点归一到 ±1）。
   *   实测发现问题：tanh(k*x) 在 x→0 处的斜率是 k，除以 tanh(k) 后
   *   小信号增益变成 k/tanh(k)。k=2.2 时为 2.2/0.9757 = 2.254，
   *   也就是【小信号被放大了 2.25 倍（+7dB）】——
   *   用户只想"加一点厚度"，结果整体响度暴增，还会推爆后面的限幅器。
   *
   *   正确做法：归一化时保持【小信号斜率 = 1】，
   *   即除以 tanh(k*x)/x 在 x→0 的极限 = k（而不是 tanh(k)）：
   *       curve = tanh(k * x) / k
   *   这样小信号区增益刚好 1（不加不减），只有大信号才被压缩（=饱和）。
   *   代价是 ±1 端点不再恰好到 ±1（而是 tanh(k)/k < 1），
   *   但这是对的 —— 饱和本来就该表现为"大信号被压下来"，
   *   而不是"整体被提上去"。响度由后面的 satDry/satWet 并联比例控制。
   *
   * 【为什么只有奇次谐波】
   *   tanh 是奇函数 -> 只产生 3f/5f/7f 奇次谐波（明亮、有力）。
   *   偶次谐波（温暖、电子管味）需要【非对称】曲线。
   *   要更多温暖感的话，可以在 tanh 前给输入加一点直流偏移
   *   （asymmetry），本项目暂不做 —— 因为直流偏移处理不当会引入
   *   "噗噗"的低频噪声，得不偿失。靠 warmth lowshelf 来补温暖感更稳。
   *
   * @param {number} k 驱动量，越大越"脏"。声乐用 1.2~4.0 是甜点区。
   */
  MicEngine.prototype._makeSaturationCurve = function (k) {
    // 曲线分辨率 2048 点：太低会有"阶梯感"，太高没必要
    var n = 2048;
    var curve = new Float32Array(n);
    var kk = k != null ? k : 2.2;
    if (kk < 0.01) kk = 0.01;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / (n - 1) - 1;          // -1 ~ +1
      // 除以 kk（= tanh 在原点斜率），保证小信号增益恒为 1
      curve[i] = Math.tanh(kk * x) / kk;
    }
    return curve;
  };

  /**
   * 温暖感 0~100（默认 50 = 不加不减）
   * 频率：180Hz lowshelf
   * 原理：人声的"厚度/磁性"来自 150~250Hz 的胸腔共鸣。
   *   加 2~3dB 会明显更"有肉"、更专业；加太多（>5dB）会糊。
   * 映射：0 -> -4dB（削薄），50 -> 0dB，100 -> +5dB
   */
  MicEngine.prototype.setWarmth = function (v, silent) {
    if (!silent) this._userTouchedPro = true;
    var val = Math.max(0, Math.min(100, v));
    this._proFx.warmth = val;
    if (!this.nodes.warmth) return;
    var g = (val - 50) / 50;                    // -1 ~ +1
    var dB = g >= 0 ? g * 5.0 : g * 4.0;        // 正 5dB / 负 4dB
    // 低配设备减半：低频增益容易引发啸叫 + 糊
    if (this.sampleRate <= RATE_LOW) dB *= 0.5;
    try { this.nodes.warmth.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.06); }
    catch (e) { this.nodes.warmth.gain.value = dB; }
  };

  /**
   * 清晰度/临场感 0~100（默认 60）
   * 频率：3.2kHz peaking
   * 原理：2~5kHz 是"咬字清晰度"和"贴脸感"的核心区。
   *   这一区提升 2~4dB，人声会立刻"从背景里跳出来"，
   *   这是所有专业人声预设的必做动作（"presence boost"）。
   * 同时联动处理两个问题频段（这是"动态 EQ"的静态近似）：
   *   - 320Hz 浑浊区：清晰度越高，同时多切一点（-1~-3dB）
   *   - 1kHz 鼻音区：同步多切一点（-1~-3dB）
   * 为什么联动：单纯的"提升清晰度"会让浑浊/鼻音更明显；
   *   专业做法是"一边提亮的、一边切暗的"，听感才干净。
   */
  MicEngine.prototype.setClarity = function (v, silent) {
    if (!silent) this._userTouchedPro = true;
    var val = Math.max(0, Math.min(100, v));
    this._proFx.clarity = val;
    var t = this.ctx ? this.ctx.currentTime : 0;
    var g = val / 100;                          // 0 ~ 1
    if (this.nodes.presence) {
      var dBp = g * 5.0;                        // 0 ~ +5dB
      if (this.sampleRate <= RATE_LOW) dBp *= 0.7;
      try { this.nodes.presence.gain.setTargetAtTime(dBp, t, 0.06); }
      catch (e) { this.nodes.presence.gain.value = dBp; }
    }
    if (this.nodes.mud) {
      // 浑浊区：0 时不动，100 时 -3.5dB
      var dBm = -g * 3.5;
      try { this.nodes.mud.gain.setTargetAtTime(dBm, t, 0.06); }
      catch (e) { this.nodes.mud.gain.value = dBm; }
    }
    if (this.nodes.nasal) {
      var dBn = -g * 3.0;
      try { this.nodes.nasal.gain.setTargetAtTime(dBn, t, 0.06); }
      catch (e) { this.nodes.nasal.gain.value = dBn; }
    }
  };

  /**
   * 空气感 0~100（默认 55）
   * 频率：12kHz highshelf
   * 原理：10~16kHz 是人声的"泛音光泽/高级感"来源。
   *   专业唱片里那种"通透、有空气"的听感，主要来自这一区的提升。
   * 映射：0 -> 0dB，100 -> +6dB
   * 【重要】低采样率（8k/16k）时这一区根本不存在，直接跳过，
   *   否则 highshelf 会在奈奎斯特频率附近产生怪声。
   */
  MicEngine.prototype.setAir = function (v, silent) {
    if (!silent) this._userTouchedPro = true;
    var val = Math.max(0, Math.min(100, v));
    this._proFx.air = val;
    if (!this.nodes.air) return;
    // 采样率不足 24k 时高频区不存在，不处理
    if (this.sampleRate < 24000) return;
    var dB = (val / 100) * 6.0;                 // 0 ~ +6dB
    if (this.sampleRate <= RATE_LOW) dB *= 0.6;
    try { this.nodes.air.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.06); }
    catch (e) { this.nodes.air.gain.value = dB; }
  };

  /**
   * 饱和/磁性 0~100（默认 30）
   * 原理见上方节点创建处的长注释。
   * 【混音比例非线性增长】这一点很关键：
   *   0~30：几乎听不出染色，只是"变厚了一点"（适合抒情/民谣）
   *   30~60：明显"有质感"，像过了电子管前级（适合流行/摇滚）
   *   60~100：强烈染色，失真感（适合刻意效果）
   * 所以湿声量不与滑块线性对应，而是 = (v/100)^1.6 * 0.55，
   *   让低档位更细腻可控：
   *     v=30 -> (0.3)^1.6*0.55 = 0.077
   *     v=60 -> (0.6)^1.6*0.55 = 0.238
   *     v=100 -> 0.55
   * 另外：驱动量也随滑块变化（1.2 ~ 4.0），低档时是"轻微软压缩"，
   *   高档时才是真饱和。
   */
  MicEngine.prototype.setDrive = function (v, silent) {
    if (!silent) this._userTouchedPro = true;
    var val = Math.max(0, Math.min(100, v));
    this._proFx.drive = val;
    var t = this.ctx ? this.ctx.currentTime : 0;
    var x = val / 100;
    if (this.nodes.satIn) {
      var inGain = 1 + x * 2.0;                 // 1 ~ 3：推入量
      try { this.nodes.satIn.gain.setTargetAtTime(x > 0.01 ? inGain : 0, t, 0.06); }
      catch (e) { this.nodes.satIn.gain.value = x > 0.01 ? inGain : 0; }
    }
    if (this.nodes.shaper) {
      var k = 1.2 + x * 2.8;                    // 1.2 ~ 4.0
      try { this.nodes.shaper.curve = this._makeSaturationCurve(k); } catch (e) {}
    }
    if (this.nodes.satWet) {
      var wet = Math.pow(x, 1.6) * 0.55;        // 见上方推导
      try { this.nodes.satWet.gain.setTargetAtTime(wet, t, 0.06); }
      catch (e) { this.nodes.satWet.gain.value = wet; }
    }
    if (this.nodes.satDry) {
      // 干声补偿：饱和会带来响度提升，等量回收一点干声避免整体变响
      var dryG = 1 - x * 0.15;
      try { this.nodes.satDry.gain.setTargetAtTime(dryG, t, 0.06); }
      catch (e) { this.nodes.satDry.gain.value = dryG; }
    }
    if (this.nodes.proOut) {
      // 总输出补偿：饱和整体会推高响度，做 -0 ~ -2.5dB 的回收
      var comp = 1 - x * 0.25;
      try { this.nodes.proOut.gain.setTargetAtTime(comp, t, 0.06); }
      catch (e) { this.nodes.proOut.gain.value = comp; }
    }
  };

  /**
   * 专业美化链总开关（跟随唱歌模式）
   * 关闭时把 5 个节点全部复位到"不处理"，保证旁路时听感与原声一致。
   */
  MicEngine.prototype.setProChain = function (on) {
    this._proOn = !!on;
    if (!this.nodes.proOut) return;
    if (on) {
      // 恢复用户设定值
      this.setWarmth(this._proFx.warmth);
      this.setClarity(this._proFx.clarity);
      this.setAir(this._proFx.air);
      this.setDrive(this._proFx.drive);
    } else {
      // 彻底旁路
      var t = this.ctx ? this.ctx.currentTime : 0;
      try {
        this.nodes.warmth.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.mud.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.nasal.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.presence.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.air.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.satIn.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.satWet.gain.setTargetAtTime(0, t, 0.05);
        this.nodes.satDry.gain.setTargetAtTime(1, t, 0.05);
        this.nodes.proOut.gain.setTargetAtTime(1, t, 0.05);
      } catch (e) {}
    }
  };

  /** 专业链预设：给不同曲风一键套用（专业软件的"人声预设"） */
  var PRO_PRESETS = {
    natural:  { name: '自然原声', warmth: 50, clarity: 45, air: 45, drive: 15, hint: '几乎不染色，保留你的原始音色' },
    pop:      { name: '流行/甜歌', warmth: 62, clarity: 72, air: 70, drive: 35, hint: '明亮贴脸，适合流行、情歌（推荐）' },
    warm:     { name: '温暖磁性', warmth: 78, clarity: 55, air: 50, drive: 45, hint: '厚实有磁性，适合民谣、低音男声' },
    powerful: { name: '力量摇滚', warmth: 58, clarity: 82, air: 62, drive: 72, hint: '有力有颗粒感，适合摇滚、快歌' },
    airy:     { name: '空灵通透', warmth: 42, clarity: 68, air: 92, drive: 20, hint: '清透有空气感，适合女声、轻音乐' }
  };

  MicEngine.prototype.getProPresets = function () { return PRO_PRESETS; };

  MicEngine.prototype.setProPreset = function (key) {
    var p = PRO_PRESETS[key];
    if (!p) return null;
    this._proPreset = key;
    this._userTouchedPro = true;
    // 先开总开关（否则 setter 会被整体旁路逻辑覆盖）
    if (!this._proOn) this.setProChain(true);
    this.setWarmth(p.warmth);
    this.setClarity(p.clarity);
    this.setAir(p.air);
    this.setDrive(p.drive);
    this._emit('state', { proPreset: key, proPresetName: p.name });
    return p;
  };

  MicEngine.prototype.getProState = function () {
    return {
      on: this._proOn,
      preset: this._proPreset || null,
      warmth: this._proFx.warmth,
      clarity: this._proFx.clarity,
      air: this._proFx.air,
      drive: this._proFx.drive
    };
  };


  /** 用户重置美化参数（切回"跟随预设"） */
  MicEngine.prototype.resetVoiceFx = function () {
    this._userTouchedVoice = false;
    this._applyPreset(this.currentPreset, false);
  };

  /**
   * 音高显示（只读，不录音）。
   *
   * 之前这里用了"简化自相关"，实测会八度跳变 + 低音报错：
   *   220Hz -> 报 110Hz、392Hz -> 报 196Hz、82Hz -> 报 1102Hz
   * 原因是自相关没有归一化、也不设阈值，容易锁到 2 倍周期，
   * 且 analyser.fftSize(512) 比窗口(2048)小，尾部全 0 干扰相关计算。
   *
   * 现在直接用 PitchUtil.yinPitch —— 与 worklet 里修音用的是同一套 YIN，
   * 保证"看到的音高"和"修的音高"是一致的。
   */
  MicEngine.prototype._startPitchMeter = function () {
    var self = this;
    if (this._pitchRAF) return;
    if (!this.nodes.analyser) return;

    var P = global.PitchUtil;
    // buffer 必须 <= analyser.fftSize，否则尾部读到的全是 0
    var size = Math.min(2048, this.nodes.analyser.fftSize || 2048);
    var buf = new Float32Array(size);
    var stop = false;
    this._pitchStop = function () { stop = true; };

    var sr = this.ctx.sampleRate;
    var tauMin = Math.max(2, Math.floor(sr / 1100));   // 上限 1100Hz
    var tauMax = Math.floor(sr / 70);                  // 下限 70Hz
    // 连续 3 帧都检测不到才清空显示，避免声音间隙时显示闪烁
    var miss = 0;

    function tick() {
      if (stop || !self.nodes.analyser) return;
      self.nodes.analyser.getFloatTimeDomainData(buf);

      // 静音门槛：太安静就不显示，避免噪声被当成音高
      var e = 0;
      for (var i = 0; i < buf.length; i += 4) e += buf[i] * buf[i];
      e = Math.sqrt(e / (buf.length / 4));

      var r = (e >= 0.006 && P && P.yinPitch)
        ? P.yinPitch(buf, sr, tauMin, tauMax, 0.12)
        : { f: 0, conf: 0 };

      // conf 太低说明不是乐音（说话/噪声），不显示
      if (r.f > 0 && r.conf > 0.6) {
        miss = 0;
        var midi = P.freqToMidi(r.f);
        self._emit('pitch', {
          freq: r.f,
          note: P.freqToNoteName(r.f),
          cents: (midi - Math.round(midi)) * 100
        });
      } else {
        miss++;
        if (miss >= 3) self._emit('pitch', null);
      }

      self._pitchRAF = requestAnimationFrame(tick);
    }
    tick();
  };

  MicEngine.prototype._stopPitchMeter = function () {
    if (this._pitchStop) this._pitchStop();
    if (this._pitchRAF) cancelAnimationFrame(this._pitchRAF);
    this._pitchRAF = null;
    this._emit('pitch', null);
  };

  /* ==========================================================================
   * 【诉求③ 后台/锁屏保活】2026-09-10 新增
   * --------------------------------------------------------------------------
   * ★先说清楚一件必须诚实告知用户的事★
   *   手机【锁屏后，系统会收回麦克风】。这是操作系统层面的权限策略，
   *   任何网页、任何 App 都绕不过去（安卓/iOS 都一样）。
   *   网上那些"锁屏也能唱歌"的说法要么是在插耳机/连蓝牙，
   *   要么是用原生 App 挂了前台服务 —— 纯网页做不到。
   *
   * 那这一段能做什么？（三件事，都有实际价值）
   *   ① Screen Wake Lock（屏幕常亮锁）
   *      → 主动阻止手机自动黑屏。这是"锁屏问题"最有效的解法：
   *        既然锁屏会断麦克风，那就【别让它锁】。
   *      → 浏览器原生 API，纯前端可用，无需任何权限申请。
   *      → 注意：Wake Lock 在页面切到后台时会被浏览器自动释放，
   *        回到前台要重新申请（下面 _setupWakeLockReacquire 处理了）。
   *
   *   ② Media Session（媒体会话）
   *      → 让浏览器把这个页面识别为"正在播放媒体的页面"。
   *        效果：切后台后系统对页面的回收优先级大幅降低，
   *        存活时间明显延长（安卓 Chrome 实测可从几十秒延长到数分钟）。
   *      → 附带好处：锁屏界面/通知栏会显示"正在使用麦克风"及我们的信息，
   *        用户一眼能看出"它还在工作"，不会误以为已经关了。
   *      → 还能接收耳机线控的播放/暂停按键。
   *
   *   ③ AudioContext 自动恢复
   *      → 从后台回到前台时，如果 ctx 被系统挂起，自动 resume。
   *
   * 不做的事（避免虚假承诺）：
   *   ✗ 不声称"锁屏也能唱歌"—— 做不到。
   *   ✓ 改为提供"不让它锁"的能力 + 三步设置指引（见 index.html 文案）。
   * ======================================================================== */

  /**
   * 申请屏幕常亮锁
   * @returns {Promise<boolean>} 是否成功
   */
  MicEngine.prototype.requestWakeLock = function () {
    var self = this;
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      // 浏览器不支持（如 iOS Safari 16 以前、老旧安卓浏览器）
      this._wakeLockSupported = false;
      this._emit('wakelock', { supported: false, active: false });
      return Promise.resolve(false);
    }
    this._wakeLockSupported = true;
    // 已经有活跃的锁，直接复用（避免重复申请）
    if (this._wakeLock && !this._wakeLock.released) {
      return Promise.resolve(true);
    }
    try {
      return navigator.wakeLock.request('screen').then(function (sentinel) {
        self._wakeLock = sentinel;
        self._emit('wakelock', { supported: true, active: true });
        /* 系统可能在任意时刻单方面释放（切后台、电量低、省电模式）。
         * 监听 release 事件，把状态同步给 UI，避免界面显示"已常亮"但实际没有。 */
        sentinel.addEventListener('release', function () {
          self._wakeLock = null;
          self._emit('wakelock', { supported: true, active: false, reason: 'released' });
        });
        return true;
      }).catch(function () {
        // 常见失败原因：页面不在前台、电量极低、用户开了省电模式
        self._wakeLock = null;
        self._emit('wakelock', { supported: true, active: false, reason: 'rejected' });
        return false;
      });
    } catch (e) {
      this._emit('wakelock', { supported: true, active: false, reason: 'throw' });
      return Promise.resolve(false);
    }
  };

  /** 释放屏幕常亮锁（用户主动关麦、或用户手动关闭常亮开关时） */
  MicEngine.prototype.releaseWakeLock = function () {
    var w = this._wakeLock;
    this._wakeLock = null;
    if (w && !w.released) {
      try { w.release(); } catch (e) {}
    }
    this._emit('wakelock', { supported: !!this._wakeLockSupported, active: false, reason: 'manual' });
  };

  /** 查询常亮状态 */
  MicEngine.prototype.isWakeLockActive = function () {
    return !!(this._wakeLock && !this._wakeLock.released);
  };

  /**
   * 设置媒体会话（让系统把本页当成"正在播放媒体的页面"）
   * 作用：
   *   ① 大幅降低切后台后被回收的概率（这是"后台保活"最实在的一招）
   *   ② 锁屏/通知栏显示我们的信息，用户能看到"它还在工作"
   *   ③ 接收耳机线控按键
   */
  MicEngine.prototype.setupMediaSession = function (info) {
    if (!('mediaSession' in navigator)) {
      this._emit('mediasession', { supported: false });
      return false;
    }
    var self = this;
    var meta = info || {};
    try {
      // 用 MediaMetadata：标题显示在锁屏界面
      if (typeof window.MediaMetadata === 'function') {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: meta.title || '手机无线音效话筒',
          artist: meta.artist || '麦克风工作中',
          album: meta.album || '本地实时处理·不上传'
        });
      }
      /* 关键：把播放状态设为 playing。
       * 很多浏览器只有在 mediaSession.playbackState = 'playing' 时
       * 才真正给这个页面"媒体页"的后台优先级。 */
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}

      /* 耳机线控 / 锁屏按钮的响应。
       * 这里刻意把 pause 也映射成"保持播放"——
       * 因为本工具是实时话筒，没有"暂停"这个语义，
       * 用户误按暂停会导致没声音，体验很差。 */
      var keep = function () {
        try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
      };
      try { navigator.mediaSession.setActionHandler('play', keep); } catch (e) {}
      try { navigator.mediaSession.setActionHandler('pause', keep); } catch (e) {}
      /* stop 是用户明确要停：真正停掉引擎 */
      try {
        navigator.mediaSession.setActionHandler('stop', function () {
          self.stop();
        });
      } catch (e) {}
      this._emit('mediasession', { supported: true });
      return true;
    } catch (e) {
      this._emit('mediasession', { supported: false });
      return false;
    }
  };

  /** 清理媒体会话（关麦时调用，让系统知道本页不再是"媒体页"） */
  MicEngine.prototype.clearMediaSession = function () {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.metadata = null; } catch (e) {}
    try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
    ['play', 'pause', 'stop'].forEach(function (a) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch (e) {}
    });
  };

  /**
   * 记住用户的保活偏好（UI 开关状态）。
   * 为什么必须：enableKeepAlive 在开麦成功后被引擎自动调用，
   * 如果不读用户偏好，"先关掉常亮开关再开麦"的用户会被强行上锁，
   * 造成"开关显示关、实际锁着"的状态错位。
   */
  MicEngine.prototype.setKeepAlivePrefs = function (p) {
    p = p || {};
    if (p.wantWakeLock != null) this._userWantWakeLock = !!p.wantWakeLock;
    if (p.wantKeepAlive != null) this._userWantKeepAlive = !!p.wantKeepAlive;
  };

  /**
   * 后台保活总开关：开麦时调用
   * 一次性把 Wake Lock + Media Session + 自动恢复全部装好。
   */
  MicEngine.prototype.enableKeepAlive = function (opts) {
    var self = this;
    var o = opts || {};
    this._keepAlive = true;
    // 用户的偏好（UI 开关）优先；opts 与历史调用兼容（显式 false 仍生效）
    this._keepAliveWantWakeLock = (o.wantWakeLock !== false) && (this._userWantWakeLock !== false);

    if (this._keepAliveWantWakeLock) this.requestWakeLock();
    this.setupMediaSession(o.mediaInfo);

    /* 页面回到前台时重新申请 Wake Lock + 麦克风自愈。
     * 为什么必须做两件事：
     * ① 浏览器在页面隐藏时会自动释放 Wake Lock，
     *    只申请一次的话，用户切出去再回来屏幕就不常亮了 —— 用户会以为坏了。
     * ② 锁屏/切后台时系统把麦克风 track 掐死（安卓隐私规定），
     *    只 resume 音频上下文不够 —— 那路死流永远不会再出声（老板实测"锁屏后没效果"）。
     *    必须体检 track，死了就重新拿一路热换上（见 reviveMicIfNeeded）。 */
    if (!this._wakeLockReacquireBound) {
      this._wakeLockReacquireBound = function () {
        if (!self._keepAlive) return;
        if (document.visibilityState !== 'visible') return;
        // ① Wake Lock 重申（跟用户偏好走）
        if (self._keepAliveWantWakeLock && !self.isWakeLockActive()) {
          self.requestWakeLock();
        }
        // ② 音频上下文 + 麦克风自愈（只要开着麦就做，不看偏好开关）
        if (self.running) {
          try { self.reviveMicIfNeeded().catch(function () {}); } catch (e) {}
        }
      };
      document.addEventListener('visibilitychange', this._wakeLockReacquireBound);
    }
    return { wakeLock: this._keepAliveWantWakeLock, mediaSession: ('mediaSession' in navigator) };
  };

  /** 关闭后台保活：关麦时调用，把系统资源还回去 */
  MicEngine.prototype.disableKeepAlive = function () {
    this._keepAlive = false;
    this.releaseWakeLock();
    this.clearMediaSession();
    if (this._wakeLockReacquireBound) {
      document.removeEventListener('visibilitychange', this._wakeLockReacquireBound);
      this._wakeLockReacquireBound = null;
    }
  };

  /** 探测本机浏览器的后台保活能力（给 UI 做能力提示，避免给用户虚假希望） */
  MicEngine.prototype.getKeepAliveCapability = function () {
    return {
      wakeLock: !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function'),
      mediaSession: ('mediaSession' in navigator),
      // 是否支持 AudioContext 自动恢复（现代浏览器都支持）
      audioCtx: !!(window.AudioContext || window.webkitAudioContext)
    };
  };

  /* ===================== 播放设备识别（蓝牙音箱/耳机，2026-09-10 新增） ===================== */
  /**
   * 列出系统的音频「输出」设备。
   * 说明（重要·如实）：
   * - 页面声音永远走「手机系统当前的播放设备」——用户连了蓝牙音箱，系统自动切过去，
   *   网页不用也不能手动指定（setSinkId 在手机浏览器上不支持）。
   * - 设备「名单」能不能看到分平台：安卓 Chrome 通常能列出来（开过麦克风权限后有名字）；
   *   iPhone Safari 只给一个「默认」，不给具体设备名（苹果的隐私规定）。
   *   所以这里返回的信息只用于「展示/确认」，识别失败也完全不影响声音从蓝牙出。
   */
  MicEngine.prototype.getOutputDevices = function () {
    return new Promise(function (resolve) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        resolve({ supported: false, outputs: [], bluetooth: false });
        return;
      }
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        var outputs = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].kind === 'audiooutput') {
            outputs.push({ label: list[i].label || '', deviceId: list[i].deviceId || '' });
          }
        }
        var joined = outputs.map(function (d) { return (d.label || '').toLowerCase(); }).join('|');
        var bt = /bluetooth|蓝牙|airpods|a2dp|buds|freebuds|headset|音箱|音响|speaker/.test(joined);
        resolve({ supported: true, outputs: outputs, bluetooth: bt });
      }).catch(function () {
        resolve({ supported: true, outputs: [], bluetooth: false });
      });
    });
  };

  /**
   * 监听设备插拔（连上/断开蓝牙音箱、插拔耳机线都会触发）。
   * 触发后发 'devices' 事件，UI 收到就刷新展示。
   * 返回是否注册成功（老浏览器没有 devicechange 也不报错）。
   */
  MicEngine.prototype.watchOutputDevices = function () {
    var self = this;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.addEventListener !== 'function') {
      return false;
    }
    if (this._devWatchOn) return true;
    this._devWatchOn = true;
    var fire = function () {
      self.getOutputDevices().then(function (info) { self._emit('devices', info); });
    };
    try {
      navigator.mediaDevices.addEventListener('devicechange', fire);
    } catch (e) {
      return false;
    }
    fire();   // 注册后先发一次，UI 一进来就有数据
    return true;
  };

  /* ===================== iOS 音频中断自愈（2026-09-10 新增） ===================== */
  /**
   * iPhone 特有：来电、Siri、别的 App 抢音频时，Safari 会把 AudioContext
   * 打成 'interrupted'（中断）状态，而且【结束后不会自己恢复】——这是苹果的
   * 行为，安卓没有这个状态。必须监听 statechange 主动 resume，否则用户
   * 接了个电话回来就没声音了，还以为软件坏了。
   */
  MicEngine.prototype.watchCtxState = function () {
    var self = this;
    if (!this.ctx || typeof this.ctx.addEventListener !== 'function') return false;
    if (this._ctxWatchOn) return true;
    this._ctxWatchOn = true;
    this.ctx.addEventListener('statechange', function () {
      var st = self.ctx.state;
      self._emit('ctxstate', { state: st });
      if (self.running && (st === 'interrupted' || st === 'suspended')) {
        /* iOS 有时一次 resume 不生效（系统刚收回还没放出来），分三次补 */
        var tryResume = function () {
          if (self.running && self.ctx.state !== 'running') {
            self.ctx.resume().catch(function () {});
          }
        };
        tryResume();
        setTimeout(tryResume, 300);
        setTimeout(tryResume, 1200);
      }
    });
    return true;
  };

  /* --- 导出 --- */
  global.MicEngine = MicEngine;
  global.MIC_PRESETS = PRESETS;
  global.MIC_SING_PRESETS = SING_PRESETS;
  /* 专业美化链预设也导出，供 UI 生成按钮 */
  global.MIC_PRO_PRESETS = PRO_PRESETS;
  global.MIC_DENOISE_SCENES = DENOISE_SCENES;

})(window);
