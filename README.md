# SD & ComfyUI Metadata Viewer

這是一個可直接部署到 GitHub Pages 的靜態網站，用於讀取 Stable Diffusion WebUI / Forge / ComfyUI 生成圖片內的 metadata。

## 功能

- 支援拖放或選擇圖片
- 支援 PNG / JPG / WebP
- PNG 支援 `tEXt`、`iTXt`、`zTXt` metadata chunk
- 讀取 SD WebUI 常見 `parameters`
- 讀取 ComfyUI 常見 `prompt` 和 `workflow`
- 整理結果會重點提取：
  - ComfyUI `KSampler` 的 `cfg`、`denoise`、`ensd`、`sampler_name`、`scheduler`、`seed`、`seed_mode`、`steps`
  - ComfyUI `UpscaleModelLoader` 的 `model_name`
  - ComfyUI `ImageScale` 的 `crop`、`height`、`image`、`upscale_method`、`width`
  - `generation_data.models` 內的 LoRA / base model 主要資料
  - `prompt`、`negativePrompt`
  - `width`、`height`、`samplerName`、`steps`、`cfgScale`、`seed`、`clipSkip`、high-res settings 等
- 可複製 metadata
- 可下載 JSON
- 全部在瀏覽器本地處理，不會把圖片上傳到伺服器

## 如何在本地打開

直接雙擊 `index.html` 即可。

也可以用 VS Code Live Server 打開。

## 如何上傳到 GitHub Pages

1. 建立一個新的 GitHub repository，例如 `sd-comfy-metadata-viewer`
2. 上傳這些檔案：
   - `index.html`
   - `style.css`
   - `app.js`
   - `README.md`
3. 進入 repository 的 **Settings**
4. 左邊選 **Pages**
5. Source 選 **Deploy from a branch**
6. Branch 選 **main**
7. Folder 選 **/root**
8. 按 **Save**
9. 等待 GitHub 產生網址

## 注意

PNG metadata 最完整。JPG / WebP 的 metadata 會受保存方式影響，有些軟件或社交平台會移除 metadata。

## 介面更新

- 固定淺色主題，移除主題切換按鈕。
- 縮小首頁標題文字和「可讀取的常見資料」方塊文字，適合 GitHub Pages 預覽。
- 「整理結果」改為只顯示主要生成 metadata，不再把完整 EXIF.UserComment 當成一般資料塞入整理區。
