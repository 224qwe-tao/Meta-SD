const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const results = document.querySelector("#results");
const cards = document.querySelector("#cards");
const statusBox = document.querySelector("#status");
const copyAllBtn = document.querySelector("#copyAllBtn");
const downloadAllBtn = document.querySelector("#downloadAllBtn");
const clearBtn = document.querySelector("#clearBtn");
const template = document.querySelector("#resultTemplate");

let allResults = [];

const decoderUtf8 = new TextDecoder("utf-8", { fatal: false });
const decoderLatin1 = new TextDecoder("iso-8859-1", { fatal: false });


dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") fileInput.click();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFiles([...event.dataTransfer.files]);
});

fileInput.addEventListener("change", (event) => handleFiles([...event.target.files]));

clearBtn.addEventListener("click", () => {
  allResults = [];
  cards.innerHTML = "";
  results.classList.add("hidden");
  setStatus("", true);
  fileInput.value = "";
});

copyAllBtn.addEventListener("click", async () => {
  await copyText(JSON.stringify(allResults, null, 2));
  setStatus("已複製全部 JSON。");
});

downloadAllBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(allResults, null, 2)], { type: "application/json" });
  downloadBlob(blob, "metadata-results.json");
});

async function handleFiles(files) {
  const imageFiles = files.filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name));
  if (!imageFiles.length) {
    setStatus("請選擇 PNG、JPG 或 WebP 圖片。");
    return;
  }

  results.classList.remove("hidden");
  setStatus(`正在讀取 ${imageFiles.length} 張圖片...`);

  for (const file of imageFiles) {
    try {
      const result = await readImageMetadata(file);
      allResults.push(result);
      renderResult(result, file);
    } catch (error) {
      console.error(error);
      const failedResult = {
        file: file.name,
        size: file.size,
        mime: file.type,
        error: error.message || String(error),
      };
      allResults.push(failedResult);
      renderError(failedResult, file);
    }
  }

  setStatus(`完成。已讀取 ${imageFiles.length} 張圖片。`);
}

async function readImageMetadata(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const kind = detectImageType(bytes);
  let extracted = {
    format: kind,
    metadata: {},
    chunks: [],
    warnings: [],
  };

  if (kind === "PNG") {
    extracted = await parsePng(bytes);
  } else if (kind === "JPEG") {
    extracted = parseJpeg(bytes);
  } else if (kind === "WEBP") {
    extracted = parseWebp(bytes);
  } else {
    extracted.warnings.push("未知圖片格式，只會嘗試掃描可見文字。");
  }

  extracted.textScan = scanReadableText(bytes);
  const analysis = analyzeMetadata(extracted.metadata, extracted.textScan);

  return {
    file: file.name,
    size: file.size,
    mime: file.type || "unknown",
    format: kind,
    imagePreviewUrl: URL.createObjectURL(file),
    detectedTool: analysis.detectedTool,
    summary: analysis.summary,
    metadata: extracted.metadata,
    chunks: extracted.chunks,
    warnings: extracted.warnings,
    textScan: extracted.textScan.slice(0, 60),
  };
}

function detectImageType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "PNG";

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) return "WEBP";

  return "UNKNOWN";
}

async function parsePng(bytes) {
  const metadata = {};
  const chunks = [];
  const warnings = [];

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > bytes.length) {
      warnings.push(`PNG chunk ${type} 長度不正常，已停止讀取。`);
      break;
    }

    const data = bytes.slice(dataStart, dataEnd);
    chunks.push({ type, length });

    try {
      if (type === "tEXt") {
        const { key, value } = parseTextChunk(data);
        if (key) metadata[key] = value;
      } else if (type === "zTXt") {
        const { key, value, warning } = await parseZtxtChunk(data);
        if (key) metadata[key] = value;
        if (warning) warnings.push(warning);
      } else if (type === "iTXt") {
        const { key, value, warning } = await parseItxtChunk(data);
        if (key) metadata[key] = value;
        if (warning) warnings.push(warning);
      }
    } catch (error) {
      warnings.push(`${type} 讀取失敗：${error.message || error}`);
    }

    offset = dataEnd + 4;
    if (type === "IEND") break;
  }

  return { format: "PNG", metadata, chunks, warnings };
}

function parseTextChunk(data) {
  const zero = data.indexOf(0);
  if (zero < 0) return { key: "", value: decoderLatin1.decode(data) };
  return {
    key: decoderLatin1.decode(data.slice(0, zero)),
    value: decoderLatin1.decode(data.slice(zero + 1)),
  };
}

async function parseZtxtChunk(data) {
  const zero = data.indexOf(0);
  if (zero < 0) return { key: "", value: "", warning: "zTXt chunk 缺少 key separator。" };

  const key = decoderLatin1.decode(data.slice(0, zero));
  const compressionMethod = data[zero + 1];
  const compressed = data.slice(zero + 2);

  if (compressionMethod !== 0) {
    return { key, value: "", warning: `${key}: 不支援的 zTXt compression method ${compressionMethod}。` };
  }

  const inflated = await inflateBytes(compressed);
  return { key, value: decoderLatin1.decode(inflated) };
}

async function parseItxtChunk(data) {
  let offset = 0;
  const keyEnd = data.indexOf(0, offset);
  if (keyEnd < 0) return { key: "", value: "", warning: "iTXt chunk 缺少 key separator。" };

  const key = decoderLatin1.decode(data.slice(offset, keyEnd));
  offset = keyEnd + 1;
  const compressedFlag = data[offset++];
  const compressionMethod = data[offset++];

  const langEnd = data.indexOf(0, offset);
  if (langEnd < 0) return { key, value: "", warning: `${key}: iTXt language tag 不完整。` };
  offset = langEnd + 1;

  const translatedEnd = data.indexOf(0, offset);
  if (translatedEnd < 0) return { key, value: "", warning: `${key}: iTXt translated keyword 不完整。` };
  offset = translatedEnd + 1;

  let textData = data.slice(offset);
  if (compressedFlag === 1) {
    if (compressionMethod !== 0) {
      return { key, value: "", warning: `${key}: 不支援的 iTXt compression method ${compressionMethod}。` };
    }
    textData = await inflateBytes(textData);
  }

  return { key, value: decoderUtf8.decode(textData) };
}

async function inflateBytes(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("此瀏覽器不支援 DecompressionStream，無法解壓縮 zTXt/iTXt。建議使用新版 Chrome / Edge / Firefox。");
  }

  const formats = ["deflate", "deflate-raw"];
  let lastError = null;

  for (const format of formats) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("解壓縮失敗。");
}

function parseJpeg(bytes) {
  const metadata = {};
  const chunks = [];
  const warnings = [];

  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;

    const length = readUint16BE(bytes, offset);
    const dataStart = offset + 2;
    const dataEnd = dataStart + length - 2;
    if (length < 2 || dataEnd > bytes.length) {
      warnings.push("JPEG segment 長度不正常，已停止讀取。");
      break;
    }

    const name = `APP${marker - 0xe0}`;
    if (marker >= 0xe0 && marker <= 0xef) {
      chunks.push({ type: name, length });
      const segment = bytes.slice(dataStart, dataEnd);

      if (marker === 0xe1 && startsWithAscii(segment, "Exif\0\0")) {
        Object.assign(metadata, parseExif(segment.slice(6), warnings));
      } else if (marker === 0xe1 && startsWithAscii(segment, "http://ns.adobe.com/xap/1.0/\0")) {
        metadata.XMP = decoderUtf8.decode(segment.slice(29)).trim();
      } else {
        const text = scanReadableText(segment).join("\n");
        if (text.length > 80) metadata[name] = text;
      }
    }

    offset = dataEnd;
  }

  return { format: "JPEG", metadata, chunks, warnings };
}

function parseWebp(bytes) {
  const metadata = {};
  const chunks = [];
  const warnings = [];

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;

    if (dataEnd > bytes.length) {
      warnings.push(`WebP chunk ${id} 長度不正常，已停止讀取。`);
      break;
    }

    const data = bytes.slice(dataStart, dataEnd);
    chunks.push({ type: id, length: size });

    if (id === "EXIF") {
      Object.assign(metadata, parseExif(data, warnings));
    } else if (id === "XMP ") {
      metadata.XMP = decoderUtf8.decode(data).trim();
    } else {
      const text = scanReadableText(data).join("\n");
      if (text.length > 80 && /prompt|workflow|parameters|seed|sampler|negative/i.test(text)) {
        metadata[id] = text;
      }
    }

    offset = dataEnd + (size % 2);
  }

  return { format: "WEBP", metadata, chunks, warnings };
}

function parseExif(tiff, warnings) {
  const metadata = {};
  if (tiff.length < 8) return metadata;

  const endianMark = ascii(tiff, 0, 2);
  const little = endianMark === "II";
  if (!little && endianMark !== "MM") {
    warnings.push("EXIF TIFF header 不正確。");
    return metadata;
  }

  const read16 = (offset) => little ? readUint16LE(tiff, offset) : readUint16BE(tiff, offset);
  const read32 = (offset) => little ? readUint32LE(tiff, offset) : readUint32BE(tiff, offset);

  const magic = read16(2);
  if (magic !== 42) {
    warnings.push("EXIF magic number 不正確。");
    return metadata;
  }

  const ifd0Offset = read32(4);
  const visited = new Set();

  const parseIfd = (offset, prefix) => {
    if (visited.has(offset) || offset + 2 > tiff.length) return;
    visited.add(offset);

    const count = read16(offset);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > tiff.length) break;

      const tag = read16(entry);
      const type = read16(entry + 2);
      const itemCount = read32(entry + 4);
      const valueOffset = entry + 8;

      if (tag === 0x8769) {
        const exifOffset = readValueOffset(tiff, valueOffset, 4, little);
        parseIfd(exifOffset, "EXIF");
        continue;
      }

      const tagName = exifTagName(tag);
      if (!tagName) continue;

      const value = readExifValue(tiff, type, itemCount, valueOffset, little);
      if (value !== null && value !== "") {
        metadata[prefix ? `${prefix}.${tagName}` : tagName] = value;
      }
    }
  };

  parseIfd(ifd0Offset, "");
  return metadata;
}

function exifTagName(tag) {
  const map = {
    0x010e: "ImageDescription",
    0x010f: "Make",
    0x0110: "Model",
    0x0131: "Software",
    0x013b: "Artist",
    0x8298: "Copyright",
    0x9003: "DateTimeOriginal",
    0x9286: "UserComment",
    0x9c9c: "XPComment",
    0x9c9b: "XPTitle",
    0x9c9d: "XPAuthor",
    0x9c9e: "XPKeywords",
    0x9c9f: "XPSubject",
  };
  return map[tag] || "";
}

function readExifValue(tiff, type, count, valueOffset, little) {
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const size = (typeSize[type] || 1) * count;
  let data;

  if (size <= 4) {
    data = tiff.slice(valueOffset, valueOffset + size);
  } else {
    const offset = readValueOffset(tiff, valueOffset, 4, little);
    if (offset + size > tiff.length) return null;
    data = tiff.slice(offset, offset + size);
  }

  if (type === 2) return stripNull(decoderUtf8.decode(data));
  if (type === 7) return decodeUndefinedExif(data);
  if (type === 1) return [...data].join(", ");
  if (type === 3) return readShortArray(data, little).join(", ");
  if (type === 4) return readLongArray(data, little).join(", ");
  return scanReadableText(data).join("\n") || null;
}

function decodeUndefinedExif(data) {
  const prefix = ascii(data, 0, Math.min(8, data.length));
  const body = data.slice(8);

  if (prefix.startsWith("ASCII")) return stripNull(decoderUtf8.decode(body));
  if (prefix.startsWith("UNICODE")) {
    // EXIF UserComment commonly uses UCS-2. Try both endian styles and keep the cleaner result.
    const be = decodeUtf16(body, false);
    const le = decodeUtf16(body, true);
    return printableScore(le) > printableScore(be) ? le : be;
  }

  const utf8 = stripNull(decoderUtf8.decode(data));
  if (utf8 && /prompt|negative|steps|seed|sampler|model|workflow|ComfyUI/i.test(utf8)) return utf8;
  return scanReadableText(data).join("\n");
}

function decodeUtf16(bytes, little) {
  const chars = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) continue;
    chars.push(String.fromCharCode(code));
  }
  return stripNull(chars.join(""));
}

function printableScore(text) {
  return (text.match(/[a-zA-Z0-9\u4e00-\u9fff.,:;_()[\]{}<>\-\s]/g) || []).length;
}

function analyzeMetadata(metadata, textScan = []) {
  const summary = {
    sdWebui: null,
    requested: extractRequestedMetadata(metadata, textScan),
    warnings: [],
  };

  const rawJoined = [
    ...Object.values(metadata).map((v) => String(v)),
    ...textScan,
  ].join("\n");

  let detectedTool = "未知 / 未找到 AI metadata";

  if ("parameters" in metadata || /Negative prompt:|Steps:\s*\d+|Sampler:|CFG scale:|Seed:/i.test(rawJoined)) {
    detectedTool = "Stable Diffusion WebUI / Forge";
    const parameters = metadata.parameters || findLikelySdParameters(rawJoined);
    summary.sdWebui = parseSdParameters(parameters);
  }

  if (requestedHasData(summary.requested) || /"class_type"\s*:|"KSampler"|"generation_data"|ComfyUI/i.test(rawJoined)) {
    detectedTool = detectedTool.includes("Stable") ? "SD WebUI + ComfyUI / generation_data" : "ComfyUI / generation_data";
  }

  return { detectedTool, summary };
}

function requestedHasData(requested = {}) {
  return Boolean(
    requested.generationData ||
    requested.ksamplers?.length ||
    requested.upscaleModelLoaders?.length ||
    requested.imageScales?.length
  );
}

function extractRequestedMetadata(metadata, textScan = []) {
  const result = {
    ksamplers: [],
    upscaleModelLoaders: [],
    imageScales: [],
    generationData: null,
    sourceKeys: [],
  };

  const seen = {
    KSampler: new Set(),
    UpscaleModelLoader: new Set(),
    ImageScale: new Set(),
  };

  const candidates = collectJsonCandidates(metadata, textScan);
  for (const candidate of candidates) {
    const generationData = findGenerationData(candidate.value);
    if (generationData && !result.generationData) {
      result.generationData = sanitizeGenerationData(generationData);
      result.sourceKeys.push(candidate.source);
    }

    collectRequestedComfyNodes(candidate.value, result, candidate.source, seen);
  }

  return result;
}

function collectJsonCandidates(metadata, textScan = []) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (source, value) => {
    if (!value || typeof value !== "object") return;
    let signature;
    try {
      signature = `${source}:${JSON.stringify(value).slice(0, 10000)}`;
    } catch {
      signature = `${source}:${Math.random()}`;
    }
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push({ source, value });
  };

  for (const [key, value] of Object.entries(metadata || {})) {
    if (value && typeof value === "object") {
      addCandidate(key, value);
      continue;
    }

    if (typeof value !== "string") continue;
    const likelyUseful = /\{|\[|Prompt:|Workflow:|generation_data|class_type|KSampler|negativePrompt/i.test(value);
    if (!likelyUseful) continue;

    for (const parsed of parseJsonFragments(value)) {
      addCandidate(key, parsed);
    }
  }

  for (const [index, text] of (textScan || []).slice(0, 30).entries()) {
    if (!/\{|\[|Prompt:|Workflow:|generation_data|class_type|KSampler|negativePrompt/i.test(String(text))) continue;
    for (const parsed of parseJsonFragments(text)) {
      addCandidate(`textScan ${index + 1}`, parsed);
    }
  }

  return candidates;
}

function parseJsonFragments(text) {
  const input = String(text || "").trim();
  const parsedDirect = safeJson(input);
  if (parsedDirect && typeof parsedDirect === "object") return [parsedDirect];

  const results = [];
  let index = input.search(/[\{\[]/);
  while (index >= 0 && index < input.length) {
    const end = findJsonFragmentEnd(input, index);
    if (end > index) {
      const fragment = input.slice(index, end + 1);
      const parsed = safeJson(fragment);
      if (parsed && typeof parsed === "object") {
        results.push(parsed);
        index = end + 1;
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }

    const nextRelative = input.slice(index).search(/[\{\[]/);
    if (nextRelative < 0) break;
    index += nextRelative;
  }

  return results;
}

function findJsonFragmentEnd(text, start) {
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.length && stack[stack.length - 1] === char) {
        stack.pop();
        if (!stack.length) return i;
      } else {
        return -1;
      }
    }
  }

  return -1;
}

function findGenerationData(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.generation_data && typeof value.generation_data === "object") return value.generation_data;
  if (value.generationData && typeof value.generationData === "object") return value.generationData;

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findGenerationData(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function sanitizeGenerationData(data) {
  const modelKeys = ["label", "type", "modelId", "modelFileId", "weight", "modelFileName", "baseModel", "baseModelType"];
  const baseModelKeys = ["label", "type", "modelId", "modelFileId", "modelFileName", "baseModel", "baseModelType"];
  const imageSettingKeys = ["width", "height", "imageCount", "samplerName", "steps", "cfgScale", "seed", "clipSkip"];
  const highResKeys = [
    "enableHr", "hrUpscaler", "hrSecondPassSteps", "hrResizeX", "hrResizeY",
    "denoisingStrength", "sdVae", "sdxl", "ksamplerName", "schedule", "guidance",
  ];

  const imageSettings = pickFields(data, imageSettingKeys);
  if (data.baseModel && typeof data.baseModel === "object") {
    imageSettings.baseModel = pickFields(data.baseModel, baseModelKeys);
  }

  return {
    models: Array.isArray(data.models) ? data.models.map((item) => pickFields(item, modelKeys)).filter((item) => Object.keys(item).length) : [],
    prompt: data.prompt || "",
    negativePrompt: data.negativePrompt || data.negative_prompt || "",
    imageSettings,
    highRes: pickFields(data, highResKeys),
  };
}

function collectRequestedComfyNodes(value, result, source, seen, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return;

  if (Array.isArray(value)) {
    for (const item of value) collectRequestedComfyNodes(item, result, source, seen, depth + 1);
    return;
  }

  if (looksLikeComfyPromptGraph(value)) {
    for (const [nodeId, node] of Object.entries(value)) {
      addRequestedNode(nodeId, node, result, source, seen);
    }
  }

  for (const key of ["prompt", "workflow", "Prompt", "Workflow"]) {
    const child = value[key];
    if (typeof child === "string") {
      for (const parsed of parseJsonFragments(child)) {
        collectRequestedComfyNodes(parsed, result, `${source}.${key}`, seen, depth + 1);
      }
    } else if (child && typeof child === "object") {
      collectRequestedComfyNodes(child, result, `${source}.${key}`, seen, depth + 1);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (["generation_data", "generationData", "models", "baseModel"].includes(key)) continue;
    if (child && typeof child === "object") {
      collectRequestedComfyNodes(child, result, `${source}.${key}`, seen, depth + 1);
    }
  }
}

function looksLikeComfyPromptGraph(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((node) => node && typeof node === "object" && typeof node.class_type === "string" && node.inputs && typeof node.inputs === "object");
}

function addRequestedNode(nodeId, node, result, source, seen) {
  const classType = node?.class_type;
  const inputs = node?.inputs || {};

  const targets = {
    KSampler: {
      output: result.ksamplers,
      keys: ["cfg", "denoise", "ensd", "sampler_name", "scheduler", "seed", "seed_mode", "steps"],
    },
    UpscaleModelLoader: {
      output: result.upscaleModelLoaders,
      keys: ["model_name"],
    },
    ImageScale: {
      output: result.imageScales,
      keys: ["crop", "height", "image", "upscale_method", "width"],
    },
  };

  const target = targets[classType];
  if (!target) return;

  const selectedInputs = pickFields(inputs, target.keys);
  const item = {
    node: String(nodeId),
    class_type: classType,
    inputs: selectedInputs,
    source,
  };

  const signature = `${nodeId}:${classType}:${JSON.stringify(selectedInputs)}`;
  if (seen[classType].has(signature)) return;
  seen[classType].add(signature);
  target.output.push(item);
}

function pickFields(object, keys) {
  const output = {};
  if (!object || typeof object !== "object") return output;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null && object[key] !== "") {
      output[key] = object[key];
    }
  }
  return output;
}

function findLikelySdParameters(text) {
  const markerIndex = text.search(/Negative prompt:|Steps:\s*\d+|Sampler:|CFG scale:|Seed:/i);
  if (markerIndex < 0) return text;
  const start = Math.max(0, markerIndex - 2000);
  return text.slice(start, markerIndex + 4000);
}

function parseSdParameters(parameters = "") {
  const result = {
    prompt: "",
    negativePrompt: "",
    settings: {},
    raw: parameters,
  };

  if (!parameters) return result;

  const negativeMarker = "Negative prompt:";
  const stepsRegex = /\n?Steps:\s*/i;
  const negativeIndex = parameters.indexOf(negativeMarker);
  const stepsMatch = parameters.match(stepsRegex);
  const stepsIndex = stepsMatch ? stepsMatch.index : -1;

  if (negativeIndex >= 0) {
    result.prompt = parameters.slice(0, negativeIndex).trim();
    if (stepsIndex >= 0) {
      result.negativePrompt = parameters.slice(negativeIndex + negativeMarker.length, stepsIndex).trim();
    } else {
      result.negativePrompt = parameters.slice(negativeIndex + negativeMarker.length).trim();
    }
  } else if (stepsIndex >= 0) {
    result.prompt = parameters.slice(0, stepsIndex).trim();
  } else {
    result.prompt = parameters.trim();
  }

  const settingsText = stepsIndex >= 0 ? parameters.slice(stepsIndex).trim() : "";
  if (settingsText) {
    for (const part of splitSettingsLine(settingsText)) {
      const colon = part.indexOf(":");
      if (colon > 0) {
        const key = part.slice(0, colon).trim();
        const value = part.slice(colon + 1).trim();
        if (key && value) result.settings[key] = value;
      }
    }
  }

  return result;
}

function splitSettingsLine(text) {
  const normalized = text.replace(/^\s*Steps:/i, "Steps:");
  const parts = [];
  let current = "";
  let depth = 0;

  for (const char of normalized) {
    if ("([{<".includes(char)) depth++;
    if (")]}>".includes(char) && depth > 0) depth--;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseComfyMetadata(metadata) {
  const result = {
    textPrompts: [],
    samplers: [],
    models: [],
    rawPromptJson: null,
    rawWorkflowJson: null,
  };

  const promptJson = safeJson(metadata.prompt);
  const workflowJson = safeJson(metadata.workflow);
  result.rawPromptJson = promptJson;
  result.rawWorkflowJson = workflowJson;

  if (promptJson && typeof promptJson === "object") {
    for (const [nodeId, node] of Object.entries(promptJson)) {
      const classType = node?.class_type || node?._meta?.title || "Unknown";
      const inputs = node?.inputs || {};

      if (typeof inputs.text === "string") {
        result.textPrompts.push({
          node: nodeId,
          type: classType,
          text: inputs.text,
        });
      }

      const modelKeys = ["ckpt_name", "vae_name", "lora_name", "control_net_name", "model_name", "unet_name", "clip_name"];
      for (const key of modelKeys) {
        if (typeof inputs[key] === "string") {
          result.models.push({
            node: nodeId,
            type: classType,
            key,
            value: inputs[key],
          });
        }
      }

      if (/sampler|ksampler/i.test(classType)) {
        result.samplers.push({
          node: nodeId,
          type: classType,
          seed: inputs.seed,
          steps: inputs.steps,
          cfg: inputs.cfg,
          sampler: inputs.sampler_name,
          scheduler: inputs.scheduler,
          denoise: inputs.denoise,
        });
      }
    }
  }

  if (workflowJson?.nodes && Array.isArray(workflowJson.nodes)) {
    for (const node of workflowJson.nodes) {
      const type = node.type || node.title || "Unknown";
      const values = node.widgets_values || [];
      if (/CLIPTextEncode|Prompt|Text/i.test(type)) {
        const textValues = values.filter((value) => typeof value === "string" && value.length > 5);
        for (const text of textValues) {
          if (!result.textPrompts.some((item) => item.text === text)) {
            result.textPrompts.push({
              node: String(node.id ?? "?"),
              type,
              text,
            });
          }
        }
      }

      if (/Checkpoint|LoRA|Lora|VAE|UNET|CLIP/i.test(type)) {
        for (const value of values) {
          if (typeof value === "string" && /\.(safetensors|ckpt|pt|bin)$/i.test(value)) {
            result.models.push({
              node: String(node.id ?? "?"),
              type,
              key: "widget",
              value,
            });
          }
        }
      }
    }
  }

  return result;
}

function renderResult(result) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector(".result-card");
  const preview = node.querySelector(".preview");
  const fileName = node.querySelector(".file-name");
  const fileDetails = node.querySelector(".file-details");
  const detected = node.querySelector(".detected");

  preview.src = result.imagePreviewUrl;
  fileName.textContent = result.file;
  fileDetails.textContent = `${result.format} · ${formatBytes(result.size)} · ${result.mime}`;
  detected.textContent = result.detectedTool;

  renderSummary(node.querySelector('[data-panel="summary"]'), result);
  renderRaw(node.querySelector('[data-panel="raw"]'), result.metadata, result);
  renderJson(node.querySelector('[data-panel="json"]'), result);

  for (const tab of node.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => activateTab(card, tab.dataset.tab));
  }

  cards.prepend(node);
}

function renderError(result, file) {
  const wrapper = document.createElement("article");
  wrapper.className = "result-card";
  wrapper.innerHTML = `
    <div class="result-header">
      <div class="preview"></div>
      <div class="file-meta">
        <h3 class="file-name"></h3>
        <p class="file-details"></p>
        <span class="badge detected">讀取失敗</span>
      </div>
    </div>
    <div class="tab-panel active">
      <div class="info-box">
        <h4>Error</h4>
        <pre></pre>
      </div>
    </div>
  `;
  wrapper.querySelector(".file-name").textContent = file.name;
  wrapper.querySelector(".file-details").textContent = `${formatBytes(file.size)} · ${file.type || "unknown"}`;
  wrapper.querySelector("pre").textContent = result.error;
  cards.prepend(wrapper);
}

function renderSummary(container, result) {
  const summary = result.summary || {};
  const requested = summary.requested || {};
  const blocks = [];

  if (result.warnings?.length) {
    blocks.push(infoBox("注意", result.warnings.join("\n")));
  }

  if (requested.ksamplers?.length) {
    blocks.push(requestedNodeBox("KSampler", requested.ksamplers));
  }

  if (requested.upscaleModelLoaders?.length) {
    blocks.push(requestedNodeBox("UpscaleModelLoader", requested.upscaleModelLoaders));
  }

  if (requested.imageScales?.length) {
    blocks.push(requestedNodeBox("ImageScale", requested.imageScales));
  }

  if (requested.generationData) {
    const gd = requested.generationData;

    if (gd.models?.length) {
      blocks.push(modelListBox("generation_data · models", gd.models));
    }

    blocks.push(infoBox("Prompt", gd.prompt || "沒有找到"));
    blocks.push(infoBox("Negative Prompt", gd.negativePrompt || "沒有找到"));
    blocks.push(settingsBox("generation_data · image settings", gd.imageSettings));

    if (Object.keys(gd.highRes || {}).length) {
      blocks.push(settingsBox("generation_data · high-res / advanced", gd.highRes));
    }
  }

  if (!requestedHasData(requested) && summary.sdWebui) {
    const sd = summary.sdWebui;
    blocks.push(infoBox("Positive Prompt", sd.prompt || "沒有找到"));
    blocks.push(infoBox("Negative Prompt", sd.negativePrompt || "沒有找到"));
    blocks.push(settingsBox("Generation Settings", sd.settings));
  }

  if (!blocks.length) {
    blocks.push(infoBox("沒有找到指定 metadata 類別", "整理結果只會提取 KSampler、UpscaleModelLoader、ImageScale、generation_data models、prompt、negativePrompt 和主要生成設定。完整內容可查看 Raw metadata 或 JSON。"));
  }

  container.innerHTML = `<div class="summary-grid">${blocks.join("")}</div>`;
}

function requestedNodeBox(title, items) {
  return `
    <section class="info-box">
      <h4>${escapeHtml(title)}</h4>
      ${items.map((item) => `
        <div class="value-block">${escapeHtml([
          `node: ${item.node}`,
          `class_type: ${item.class_type}`,
          ...objectToLines(item.inputs),
        ].join("\n"))}</div>
      `).join("")}
    </section>
  `;
}

function modelListBox(title, models) {
  return `
    <section class="info-box">
      <h4>${escapeHtml(title)}</h4>
      ${models.map((model, index) => `
        <div class="value-block">${escapeHtml([
          `model ${index + 1}`,
          ...objectToLines(model),
        ].join("\n"))}</div>
      `).join("")}
    </section>
  `;
}

function objectToLines(object = {}) {
  return Object.entries(object).map(([key, value]) => `${key}: ${formatSettingValue(value)}`);
}

function infoBox(title, value) {
  return `
    <section class="info-box">
      <h4>${escapeHtml(title)}</h4>
      <div class="value-block">${escapeHtml(value)}</div>
    </section>
  `;
}

function listBox(title, items) {
  return `
    <section class="info-box">
      <h4>${escapeHtml(title)}</h4>
      ${items.map((item) => `<div class="value-block">${escapeHtml(item)}</div>`).join("")}
    </section>
  `;
}

function settingsBox(title, settings) {
  const entries = Object.entries(settings || {});
  if (!entries.length) return infoBox(title, "沒有找到");
  return `
    <section class="info-box">
      <h4>${escapeHtml(title)}</h4>
      <table class="settings-table">
        <tbody>
          ${entries.map(([key, value]) => `
            <tr>
              <th>${escapeHtml(key)}</th>
              <td>${escapeHtml(formatSettingValue(value))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function formatSettingValue(value) {
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function renderRaw(container, metadata, result) {
  const entries = Object.entries(metadata || {});
  if (!entries.length) {
    container.innerHTML = `<div class="info-box"><h4>Raw metadata</h4><p>沒有找到 raw metadata。</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="kv-list">
      ${entries.map(([key, value], index) => `
        <section class="kv-item">
          <div class="kv-head">
            <strong>${escapeHtml(key)}</strong>
            <button type="button" data-copy-index="${index}">複製</button>
          </div>
          <pre class="kv-value">${escapeHtml(formatMaybeJson(value))}</pre>
        </section>
      `).join("")}
      <section class="info-box">
        <h4>Chunks / Segments</h4>
        <pre>${escapeHtml(JSON.stringify(result.chunks || [], null, 2))}</pre>
      </section>
    </div>
  `;

  container.querySelectorAll("[data-copy-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [key, value] = entries[Number(button.dataset.copyIndex)];
      await copyText(String(value));
      setStatus(`已複製 ${key}。`);
    });
  });
}

function renderJson(container, result) {
  container.innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
}

function activateTab(card, tabName) {
  card.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  card.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tabName));
}

function safeJson(value) {
  if (typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatMaybeJson(value) {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  const parsed = safeJson(value);
  return parsed ? JSON.stringify(parsed, null, 2) : value;
}

function scanReadableText(bytes) {
  const text = decoderUtf8.decode(bytes);
  const matches = text.match(/[ -~\u00a0-\uffff]{20,}/g) || [];
  return [...new Set(matches.map((item) => stripNull(item).trim()).filter(Boolean))]
    .filter((item) => /prompt|negative|steps|seed|sampler|model|workflow|ComfyUI|parameters|cfg|checkpoint|lora/i.test(item))
    .slice(0, 100);
}

function setStatus(message, hide = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("hidden", hide || !message);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function startsWithAscii(bytes, text) {
  return ascii(bytes, 0, text.length) === text;
}

function stripNull(text) {
  return String(text).replace(/\0/g, "").trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | ((bytes[offset + 3] << 24) >>> 0)) >>> 0;
}

function readValueOffset(bytes, offset, size, little) {
  if (size === 2) return little ? readUint16LE(bytes, offset) : readUint16BE(bytes, offset);
  return little ? readUint32LE(bytes, offset) : readUint32BE(bytes, offset);
}

function readShortArray(data, little) {
  const values = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    values.push(little ? readUint16LE(data, i) : readUint16BE(data, i));
  }
  return values;
}

function readLongArray(data, little) {
  const values = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    values.push(little ? readUint32LE(data, i) : readUint32BE(data, i));
  }
  return values;
}
