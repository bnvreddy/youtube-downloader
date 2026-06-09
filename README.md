---
title: YT Downloader
emoji: 📥
colorFrom: red
colorTo: red
sdk: docker

app_file: app.py
pinned: false
short_description: A simple and efficient YouTube video and audio downloader.
---

# 📥 YouTube Downloader

A lightweight web application hosted on Hugging Face Spaces that allows users to download YouTube videos or extract high-quality audio streams.

## 🚀 Features
* **Video Downloads:** Fetch videos in various resolutions.
* **Audio Extraction:** Convert and download YouTube videos directly into MP3/M4A format.
* **Fast Processing:** Powered by `yt-dlp` for stable and fast downloads.

## 🛠️ Local Installation

If you want to run this project locally, follow these steps:

1. **Clone the repository:**
   ```bash
   git clone [https://huggingface.co/spaces/urstrulynvr/yt-downloader](https://huggingface.co/spaces/urstrulynvr/yt-downloader)
   cd yt-downloader

```

2. **Install dependencies:**
Make sure you have Python installed, then run:
```bash
pip install -r requirements.满足.txt

```


*(Note: Ensure `ffmpeg` is installed on your system if you are processing audio local extraction).*
3. **Run the app:**
```bash
python app.py

```



## 📦 Requirements

This Space relies on the following major libraries (defined in `requirements.txt`):

* `gradio` (or `streamlit` depending on your backend choice)
* `yt-dlp`

```

---

### Key YAML Configuration Options Explained

If you need to tweak the top metadata configuration, here is what the primary keys mean:

* **`sdk`**: The framework you are using. Common options are `gradio`, `streamlit`, or `docker`.
* **`sdk_version`**: Specify the version of the SDK you built the app on to ensure Hugging Face doesn't accidentally break your UI during future platform updates.
* **`app_file`**: The entry point file for your application execution (usually `app.py` or `main.py`).
* **`emoji` & `colorFrom` / `colorTo`**: Controls the visual presentation of your space card on the Hugging Face hub list.

```