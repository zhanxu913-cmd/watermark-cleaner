/**
 * 全离线视频去水印（零后端终极版）
 *
 * 链路（全部在手机上完成，无任何网络请求）：
 *   1. wx.createVideoDecoder   逐帧解码出 RGBA 像素
 *   2. WebGL 着色器对水印区域做 马赛克 / 模糊 / 智能填充(边缘推算)
 *   3. wx.createMediaRecorder  把处理后的画面逐帧录制回视频文件（≥2.11.0）
 *   4. wx.createMediaContainer 把原视频音轨与处理后画面合并导出（≥2.9.0）
 *
 * 已知限制（微信平台能力上限，非付费墙）：
 *   - 录制比特率最高 3000kbps，720p 及以下画质良好
 *   - 录制按帧率实时推进，处理 10 秒片段约需 10-30 秒
 *   - 仅支持 WebGL1（webgl2 / 2d 画布不支持录制）
 *   - 输出时段被裁剪时无法同步裁剪音轨 → 裁剪输出为无声视频
 *   - 「智能填充」为边缘像素向内推算的近似，复杂背景不如服务端 delogo
 */

'use strict';

const MIN_REC_DURATION = 5; // MediaRecorder duration 参数最小值（秒）
const MAX_EDGE = 720; // 输出画面最长边上限（性能与码率的平衡点）

/* ============================================================
   能力检测
   ============================================================ */

function isSupported() {
  return (
    typeof wx.createVideoDecoder === 'function' &&
    typeof wx.createMediaRecorder === 'function' &&
    typeof wx.createMediaContainer === 'function' &&
    typeof wx.createOffscreenCanvas === 'function'
  );
}

function unsupportedError() {
  const e = new Error('这台手机的微信版本较低，暂不支持本地视频处理，请升级微信后重试');
  e.code = 'UNSUPPORTED';
  return e;
}

/* ============================================================
   小工具
   ============================================================ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 回调式 API 转 Promise */
function callP(obj, method, opts) {
  return new Promise((resolve, reject) => {
    try {
      obj[method](
        Object.assign({}, opts, {
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || method + ' 失败'))
        })
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** MediaRecorder.start / stop：优先 Promise 风格（≥2.16.1），低版本退回事件监听 */
function recCall(rec, method, eventName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const bad = (e) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(method + ' 失败'));
      }
    };
    try {
      const r = rec[method]();
      if (r && typeof r.then === 'function') {
        r.then(ok, bad);
        return;
      }
      // 同步返回（低版本）：挂事件 + 兜底放行
      try {
        rec.on(eventName, ok);
        rec.on('error', bad);
      } catch (e2) {
        /* 忽略 */
      }
      setTimeout(ok, 600);
    } catch (e) {
      try {
        rec.on(eventName, ok);
        rec.on('error', bad);
        rec[method]();
      } catch (e2) {
        bad(e2);
      }
    }
  });
}

/** 逐帧请求录制：Promise 风格优先，低版本传回调 */
function requestFrame(rec) {
  return new Promise((resolve, reject) => {
    try {
      const r = rec.requestFrame(resolve);
      if (r && typeof r.then === 'function') r.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/** 解码帧时间戳归一化为秒（部分机型返回微秒） */
function ptsToSec(pts) {
  const v = Number(pts) || 0;
  return v > 10000 ? v / 1e6 : v;
}

function evenize(n) {
  n = Math.round(n);
  return n % 2 ? n - 1 : n;
}

/** 计算输出画布尺寸：限制最长边、保持比例、宽高取偶（编码器友好） */
function fitSize(w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: evenize(w * scale), h: evenize(h * scale) };
}

/* ============================================================
   WebGL：一屏一 quad，水印处理全部在片元着色器完成
   ============================================================ */

const VERT_SRC = [
  'attribute vec2 a_pos;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);',
  '  gl_Position = vec4(a_pos, 0.0, 1.0);',
  '}'
].join('\n');

const FRAG_SRC = [
  'precision mediump float;',
  'varying vec2 v_uv;',
  'uniform sampler2D u_tex;',
  'uniform vec2 u_res;',
  'uniform vec4 u_uvT;', // 采样变换：suv = u_uvT.xy * uv + u_uvT.zw（crop 模式用）
  'uniform int u_mode;', // 0 无处理 1 模糊 2 马赛克 3 智能填充
  'uniform int u_regionCount;',
  'uniform vec4 u_regions[4];', // 归一化 x,y,w,h（左上原点）
  'uniform vec2 u_taps[12];', // 模糊采样偏移（单位圆）
  'uniform float u_blurPx;',
  'uniform float u_blockPx;',
  'vec2 samp(vec2 uv) { return u_uvT.xy * uv + u_uvT.zw; }',
  'void main() {',
  '  vec2 uv = v_uv;',
  '  vec3 col = texture2D(u_tex, samp(uv)).rgb;',
  // 不用 break/continue：部分 WebGL1 驱动对循环控制支持差，全部用条件包裹
  '  for (int i = 0; i < 4; i++) {',
  '    if (i < u_regionCount) {',
  '      vec4 r = u_regions[i];',
  '      vec2 lo = r.xy;',
  '      vec2 hi = r.xy + r.zw;',
  '      if (uv.x > lo.x && uv.x < hi.x && uv.y > lo.y && uv.y < hi.y) {',
  '        vec2 dpx = min(uv - lo, hi - uv) * u_res;',
  '        float dEdge = min(dpx.x, dpx.y);', // dpx 是 vec2，只有 xy 分量
  '        float feather = smoothstep(0.0, 2.0, dEdge);', // 边缘 2px 过渡，避免硬边
  '        vec3 eff = col;',
  '        if (u_mode == 2) {',
  // 马赛克：像素块量化后再采样
  '          vec2 px = uv * u_res;',
  '          vec2 q = (floor(px / u_blockPx) + 0.5) * u_blockPx / u_res;',
  '          eff = texture2D(u_tex, samp(q)).rgb;',
  '        } else if (u_mode == 1) {',
  // 模糊：12 点圆盘采样
  '          vec3 acc = vec3(0.0);',
  '          for (int k = 0; k < 12; k++) {',
  '            acc += texture2D(u_tex, samp(uv + u_taps[k] * u_blurPx / u_res)).rgb;',
  '          }',
  '          eff = acc / 12.0;',
  '        } else if (u_mode == 3) {',
  // 智能填充：四条边的画面按距离加权向内推算（delogo 近似）
  '          vec2 p01 = (uv - lo) / r.zw;',
  '          vec3 cT = texture2D(u_tex, samp(vec2(uv.x, lo.y))).rgb;',
  '          vec3 cB = texture2D(u_tex, samp(vec2(uv.x, hi.y))).rgb;',
  '          vec3 cL = texture2D(u_tex, samp(vec2(lo.x, uv.y))).rgb;',
  '          vec3 cR = texture2D(u_tex, samp(vec2(hi.x, uv.y))).rgb;',
  '          float wt = 1.0 / (p01.y + 0.03);',
  '          float wb = 1.0 / (1.0 - p01.y + 0.03);',
  '          float wl = 1.0 / (p01.x + 0.03);',
  '          float wr = 1.0 / (1.0 - p01.x + 0.03);',
  '          eff = (cT * wt + cB * wb + cL * wl + cR * wr) / (wt + wb + wl + wr);',
  '        }',
  '        col = mix(col, eff, feather);',
  '      }',
  '    }',
  '  }',
  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');

/** 12 点圆盘采样偏移（金兹分布：4 主轴 + 4 对角 + 4 旋转补偿） */
const BLUR_TAPS = [
  [1.0, 0.0],
  [-1.0, 0.0],
  [0.0, 1.0],
  [0.0, -1.0],
  [0.707, 0.707],
  [-0.707, 0.707],
  [0.707, -0.707],
  [-0.707, -0.707],
  [0.924, 0.383],
  [-0.383, 0.924],
  [0.383, -0.924],
  [-0.924, -0.383]
];

function createRenderer(canvas, outW, outH, mode, regions, uvT) {
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL 初始化失败');

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('着色器编译失败: ' + msg);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  // 全屏 quad
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // 纹理（解码帧为 RGBA，尺寸非 2 的幂：必须 CLAMP_TO_EDGE + 无 mipmap）
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const U = (name) => gl.getUniformLocation(prog, name);
  gl.uniform2f(U('u_res'), outW, outH);
  gl.uniform4f(U('u_uvT'), uvT.sx, uvT.sy, uvT.tx, uvT.ty);

  const MODE_ID = { none: 0, blur: 1, mosaic: 2, fill: 3 };
  gl.uniform1i(U('u_mode'), MODE_ID[mode] || 0);

  const rs = (regions || []).slice(0, 4);
  gl.uniform1i(U('u_regionCount'), rs.length);
  for (let i = 0; i < 4; i++) {
    const r = rs[i] || { x: 0, y: 0, w: 0, h: 0 };
    gl.uniform4f(U('u_regions[' + i + ']'), r.x, r.y, r.w, r.h);
  }

  const tapsLoc = U('u_taps[0]');
  for (let k = 0; k < 12; k++) {
    gl.uniform2f(gl.getUniformLocation(prog, 'u_taps[' + k + ']'), BLUR_TAPS[k][0], BLUR_TAPS[k][1]);
  }

  const minDim = Math.min(outW, outH);
  gl.uniform1f(U('u_blurPx'), Math.max(10, Math.min(24, minDim * 0.03)));
  gl.uniform1f(U('u_blockPx'), Math.max(12, Math.min(28, minDim / 26)));

  gl.viewport(0, 0, outW, outH);

  return {
    /** 上传一帧并绘制 */
    draw(frame) {
      const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    destroy() {
      try {
        gl.deleteTexture(tex);
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
      } catch (e) {
        /* 忽略 */
      }
    }
  };
}

/* ============================================================
   主流程
   ============================================================ */

/**
 * 全离线视频去水印
 * @param {object} opts
 * @param {string} opts.src 本地视频路径
 * @param {string} opts.mode blur | mosaic | fill | crop
 * @param {object} [opts.region] 归一化区域 {x,y,w,h}；crop 模式下为「保留区域」
 * @param {{start:number,end:number}} opts.timeRange 处理时段（秒）
 * @param {function} [opts.onProgress] (pct 0-100, label) => void
 * @returns {Promise<{tempFilePath:string, width:number, height:number, duration:number, hasAudio:boolean, audioDropped:boolean}>}
 */
async function processVideo(opts) {
  if (!isSupported()) throw unsupportedError();

  const o = opts || {};
  if (!o.src) throw new Error('缺少视频文件');

  const report = (pct, label) => {
    try {
      o.onProgress && o.onProgress(Math.max(0, Math.min(100, Math.round(pct))), label || '');
    } catch (e) {
      /* 进度回调异常不中断主流程 */
    }
  };

  const mode = o.mode || 'blur';
  const startSec = Math.max(0, Number((o.timeRange && o.timeRange.start) || 0));
  const endSec = Math.max(startSec + 0.5, Number((o.timeRange && o.timeRange.end) || 0));
  const trimApplied = startSec > 0.25;

  report(2, '读取视频信息');

  // 1) 视频元信息（宽高/帧率/时长）
  let info = null;
  try {
    info = await callP(wx, 'getVideoInfo', { src: o.src });
  } catch (e) {
    info = null;
  }
  const vw = (info && info.width) || 0;
  const vh = (info && info.height) || 0;
  const totalSec = (info && info.duration) || 0;
  let fps = (info && Number(info.fps)) || 0;
  if (!fps || fps < 5 || fps > 120) fps = 25; // 帧率异常时兜底
  fps = Math.min(fps, 30); // 录制帧率上限 30，够流畅且省电

  // 2) 输出尺寸与采样变换
  let size;
  let uvT = { sx: 1, sy: 1, tx: 0, ty: 0 };
  let effMode = mode;
  let regions = [];

  if (mode === 'crop') {
    // 裁剪模式：region 为保留区域，输出画面 = 该区域
    const r = o.region && o.region.w > 0.02 && o.region.h > 0.02 ? o.region : null;
    if (!r) throw new Error('裁剪模式需要先框选要保留的画面区域');
    if (vw && vh) {
      size = fitSize(r.w * vw, r.h * vh);
    } else {
      size = { w: 640, h: 360 };
    }
    uvT = { sx: r.w, sy: r.h, tx: r.x, ty: r.y };
    effMode = 'none';
  } else {
    if (vw && vh) size = fitSize(vw, vh);
    else size = { w: 640, h: 360 };
    if (o.region && o.region.w > 0.005 && o.region.h > 0.005) regions = [o.region];
  }

  // 3) 离屏 WebGL 画布 + 录制器
  let canvas;
  try {
    canvas = wx.createOffscreenCanvas({ type: 'webgl', width: size.w, height: size.h });
  } catch (e) {
    canvas = null;
  }
  if (!canvas || !canvas.getContext) throw unsupportedError();

  const renderer = createRenderer(canvas, size.w, size.h, effMode, regions, uvT);

  const rec = wx.createMediaRecorder(canvas, {
    fps,
    duration: Math.max(MIN_REC_DURATION, Math.ceil(endSec - startSec)),
    videoBitsPerSecond: 3000,
    width: size.w,
    height: size.h
  });
  await recCall(rec, 'start', 'start');

  // 4) 逐帧解码 → 绘制 → 录制
  const decoder = wx.createVideoDecoder();
  let outTempPath = '';
  let recorded = 0;

  try {
    await callP(decoder, 'start', { source: o.src });

    // 快进到起点（失败则顺序跳过，循环里有双重兜底）
    if (startSec > 0.5) {
      try {
        await callP(decoder, 'seek', { position: startSec });
      } catch (e) {
        /* 忽略，靠循环内跳帧 */
      }
    }

    const estTotal = Math.max(1, Math.round((endSec - startSec) * fps));
    const eps = 0.04;
    let firstFrame = null;

    // 起播阶段部分机型需要几次尝试才出第一帧
    for (let i = 0; i < 40 && !firstFrame; i++) {
      try {
        firstFrame = await callP(decoder, 'getFrameData');
      } catch (e) {
        await sleep(60);
      }
    }
    if (!firstFrame) throw new Error('视频解码失败，格式可能不受支持（建议使用 mp4/h264）');

    let frame = firstFrame;
    while (frame) {
      const t = ptsToSec(frame.pts);
      if (t > endSec + 0.15) break;

      if (t >= startSec - eps) {
        renderer.draw(frame);
        await requestFrame(rec);
        recorded += 1;
        if (recorded % 3 === 0 || recorded === estTotal) {
          report(8 + 80 * Math.min(1, recorded / estTotal), '逐帧处理 ' + recorded + ' 帧');
        }
      }

      try {
        frame = await callP(decoder, 'getFrameData');
      } catch (e) {
        break; // 解码结束
      }
    }

    if (!recorded) throw new Error('所选时间段内没有可用的视频帧，请调整时间区间');

    try {
      await callP(decoder, 'stop');
    } catch (e) {
      /* 忽略 */
    }
    try {
      decoder.remove();
    } catch (e) {
      /* 忽略 */
    }

    report(88, '生成视频');
    outTempPath = await recStop(rec);
  } catch (e) {
    try {
      rec.destroy();
    } catch (e2) {
      /* 忽略 */
    }
    try {
      decoder.remove();
    } catch (e2) {
      /* 忽略 */
    }
    renderer.destroy();
    throw e;
  }

  try {
    rec.destroy();
  } catch (e) {
    /* 忽略 */
  }
  renderer.destroy();

  if (!outTempPath) throw new Error('视频导出失败，请重试');

  // 5) 音轨处理：整段处理 → 合并原音轨；裁剪过 → 无法对齐音轨，输出无声
  const fullRange = !trimApplied && (!totalSec || endSec >= totalSec - 0.6);
  let finalPath = outTempPath;
  let hasAudio = false;
  let audioDropped = false;

  if (fullRange) {
    report(90, '合并音轨');
    try {
      const merged = await mergeAudio(outTempPath, o.src);
      if (merged) {
        finalPath = merged;
        hasAudio = true;
        // 无声中间产物删除，省用户空间
        try {
          wx.getFileSystemManager().unlinkSync(outTempPath);
        } catch (e) {
          /* 忽略 */
        }
      }
    } catch (e) {
      // 音轨合并失败不阻断：输出无声视频
      audioDropped = true;
    }
  } else {
    audioDropped = true;
  }

  report(100, '完成');
  return {
    tempFilePath: finalPath,
    width: size.w,
    height: size.h,
    duration: Math.round((endSec - startSec) * 10) / 10,
    hasAudio,
    audioDropped
  };
}

/**
 * 停止录制并取产物路径。
 * 产物路径可能从 stop() 的 Promise 返回值来，也可能只从 'stop' 事件来，
 * 两条路都挂上，先到先得。
 */
function recStop(rec) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (p) => {
      if (!settled) {
        settled = true;
        resolve(p || '');
      }
    };
    const bad = (e) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error('停止录制失败'));
      }
    };
    try {
      try {
        rec.on('stop', (r) => done(r && r.tempFilePath));
      } catch (e) {
        /* 忽略 */
      }
      const r = rec.stop();
      if (r && typeof r.then === 'function') {
        // 返回值没带路径时不结算，等 'stop' 事件或兜底定时器
        r.then((x) => {
          if (x && x.tempFilePath) done(x.tempFilePath);
        }, bad);
      }
      // 兜底：两条路都没给路径时放空（上层报导出失败）
      setTimeout(() => done(''), 5000);
    } catch (e) {
      bad(e);
    }
  });
}

/**
 * 用 MediaContainer 把「处理后画面 + 原视频音轨」合成新文件
 * @returns {Promise<string>} 最终文件路径；原视频没有音轨时 resolve('')
 */
async function mergeAudio(silentVideo, srcVideo) {
  const containerV = wx.createMediaContainer();
  const containerA = wx.createMediaContainer();

  try {
    // 处理后画面：只取视频轨
    const dsOut = await callP(containerV, 'extractDataSource', { source: silentVideo });
    const tracksOut = (dsOut && dsOut.tracks) || [];
    const videoTrack = tracksOut.filter((t) => t.kind === 'video')[0];
    if (!videoTrack) throw new Error('处理结果缺少视频轨');

    // 原视频：只取音轨
    const dsSrc = await callP(containerA, 'extractDataSource', { source: srcVideo });
    const tracksSrc = (dsSrc && dsSrc.tracks) || [];
    const audioTrack = tracksSrc.filter((t) => t.kind === 'audio')[0];
    if (!audioTrack) return ''; // 原视频本就无声，直接用录制产物

    containerV.addTrack(videoTrack);
    containerV.addTrack(audioTrack);
    const exported = await callP(containerV, 'export');
    const path = exported && (exported.tempFilePath || exported.tempFilePaths && exported.tempFilePaths[0]);
    if (!path) throw new Error('音轨合成失败');
    return path;
  } finally {
    try {
      containerA.destroy();
    } catch (e) {
      /* 忽略 */
    }
    try {
      containerV.destroy();
    } catch (e) {
      /* 忽略 */
    }
  }
}

module.exports = {
  isSupported,
  processVideo
};
