import yt_dlp
import os
import tempfile
import re
import shutil
import time
import datetime
from google.cloud import storage
import google.auth
from google.auth.transport.requests import Request

# Global dictionary to store download progress and states
download_tasks = {}

# --- LIGHTWEIGHT RAM CACHE ---
_CACHE_MAX_SIZE = 15 
_CACHE_TTL = 300 
_info_cache = {} 

class DownloadCancelled(Exception):
    pass

ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

def clean_ytdlp_string(text):
    if not text: return ""
    text = ANSI_ESCAPE.sub('', text)
    text = text.replace('\r', '').replace('\n', '').strip()
    return text

def _get_base_opts():
    opts = {
        'quiet': True,
        'no_warnings': True,
        'remote_components': ['ejs:github'],
        'sleep_interval': 3,
    }
    if os.path.exists('youtube_cookies.txt'):
        opts['cookiefile'] = 'youtube_cookies.txt'
    return opts

def _get_full_info_cached(url: str):
    current_time = time.time()
    expired_keys = [k for k, v in _info_cache.items() if current_time - v['time'] > _CACHE_TTL]
    for k in expired_keys:
        _info_cache[k]['data'] = None 
        del _info_cache[k]
        
    if url in _info_cache:
        return _info_cache[url]['data']
        
    base_opts = _get_base_opts()
    base_opts['skip_download'] = True
    
    with yt_dlp.YoutubeDL(base_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        
    if len(_info_cache) >= _CACHE_MAX_SIZE:
        oldest_key = min(_info_cache, key=lambda k: _info_cache[k]['time'])
        _info_cache[oldest_key]['data'] = None 
        del _info_cache[oldest_key]
        
    _info_cache[url] = {'data': info, 'time': current_time}
    return info

def progress_hook(d, task_id):
    if not task_id or task_id not in download_tasks:
        return
        
    if download_tasks[task_id].get('cancel_requested'):
        download_tasks[task_id]['status'] = 'cancelled'
        raise DownloadCancelled("Download cancelled by user.")
        
    if d['status'] == 'downloading':
        raw_percent = d.get('_percent_str', '0.0%')
        raw_speed = d.get('_speed_str', '')
        raw_eta = d.get('_eta_str', '')

        clean_percent = clean_ytdlp_string(raw_percent)
        clean_speed = clean_ytdlp_string(raw_speed)
        clean_eta = clean_ytdlp_string(raw_eta)

        match = re.search(r'(\d+\.?\d*)', clean_percent)
        percent_value = match.group(1) if match else "0"

        info = d.get('info_dict') or {}
        vcodec = info.get('vcodec', 'none')
        acodec = info.get('acodec', 'none')
        ext = info.get('ext', '')
        
        if ext in ['vtt', 'srt', 'ass'] or (vcodec == 'none' and acodec != 'none' and ext == 'mp3'):
            stream_type = "Subtitle/Convert" if ext in ['vtt', 'srt'] else "Audio"
        elif vcodec != 'none':
            stream_type = "Video"
        elif acodec != 'none':
            stream_type = "Audio"
        else:
            stream_type = "Data"

        download_tasks[task_id].update({
            'progress': percent_value,
            'speed': clean_speed if clean_speed else "N/A",
            'eta': clean_eta if clean_eta else "N/A",
            'status': 'downloading',
            'stream_type': stream_type
        })
        
    elif d['status'] == 'finished':
        download_tasks[task_id].update({
            'progress': '100',
            'speed': '',
            'eta': '',
            'status': 'merging',
            'stream_type': ''
        })

def get_video_info(url: str):
    base_opts = _get_base_opts()
    base_opts.update({
        'extract_flat': True,
        'skip_download': True,
    })
    
    with yt_dlp.YoutubeDL(base_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        videos = []
        if info and 'entries' in info:
            for entry in info['entries']:
                if entry:
                    videos.append({
                        "id": entry.get('id'),
                        "title": entry.get('title', 'Unknown Title'),
                        "thumbnail": entry.get('thumbnails', [{}])[-1].get('url') if entry.get('thumbnails') else None,
                        "url": f"https://www.youtube.com/watch?v={entry.get('id')}"
                    })
        elif info:
            videos.append({
                "id": info.get('id'),
                "title": info.get('title', 'Unknown Title'),
                "thumbnail": info.get('thumbnail'),
                "url": url
            })
        return videos

def list_available_formats(url: str):
    info = _get_full_info_cached(url)
    if not info: return []
    
    duration = info.get('duration')
    formats = []
    seen_heights = set()
    
    # 1. Video Resolutions
    valid_formats = [f for f in info.get('formats', []) if f.get('height') and f.get('vcodec') != 'none']
    valid_formats.sort(key=lambda x: (x.get('height', 0), x.get('tbr', 0)), reverse=True)

    for f in valid_formats:
        height = f['height']
        if height not in seen_heights:
            seen_heights.add(height)
            
            size = f.get('filesize') or f.get('filesize_approx')
            if not size and duration and f.get('tbr'):
                size = (f['tbr'] * 1000 / 8) * duration * 1.3
            
            size_mb = round(size / (1024 * 1024), 1) if size else "Unknown"
            
            label = f"{height}p"
            if height >= 2160: label = f"4K ({height}p)"
            elif height >= 1440: label = f"2K ({height}p)"
            
            formats.append({
                "id": f"video_{height}",
                "label": f"{label} Video + Audio",
                "size": f"~{size_mb} MB" if isinstance(size_mb, float) else size_mb,
                "max_resolution": height,
                "audio_only": False,
                "audio_format": None
            })
    
    # 2. Audio Only Formats
    valid_audio = [f for f in info.get('formats', []) if f.get('acodec') != 'none' and f.get('vcodec') == 'none' and f.get('abr')]
    valid_audio.sort(key=lambda x: x.get('abr', 0), reverse=True)

    # Find best M4A (AAC)
    best_m4a = next((f for f in valid_audio if f.get('ext') == 'm4a'), None)
    if best_m4a:
        size = best_m4a.get('filesize') or best_m4a.get('filesize_approx')
        if not size and duration and best_m4a.get('tbr'):
            size = (best_m4a['tbr'] * 1000 / 8) * duration
        size_mb = round(size / (1024 * 1024), 1) if size else "Unknown"
        formats.append({
            "id": "audio_m4a",
            "label": f"Audio Only (M4A/AAC)",
            "size": f"~{size_mb} MB" if isinstance(size_mb, float) else size_mb,
            "max_resolution": None,
            "audio_only": True,
            "audio_format": "m4a"
        })

    # Find best Webm (Opus - usually highest quality native)
    best_webm = next((f for f in valid_audio if f.get('ext') == 'webm'), None)
    if best_webm:
        size = best_webm.get('filesize') or best_webm.get('filesize_approx')
        if not size and duration and best_webm.get('tbr'):
            size = (best_webm['tbr'] * 1000 / 8) * duration
        size_mb = round(size / (1024 * 1024), 1) if size else "Unknown"
        formats.append({
            "id": "audio_webm",
            "label": f"Audio Only (Webm/Opus)",
            "size": f"~{size_mb} MB" if isinstance(size_mb, float) else size_mb,
            "max_resolution": None,
            "audio_only": True,
            "audio_format": "webm"
        })

    # Always offer MP3 (Forced conversion via FFmpeg)
    if duration:
        size = (192000 / 8) * duration # Estimate for 192kbps
        size_mb = round(size / (1024 * 1024), 1)
        formats.append({
            "id": "audio_mp3",
            "label": "Audio Only (MP3)",
            "size": f"~{size_mb} MB",
            "max_resolution": None,
            "audio_only": True,
            "audio_format": "mp3"
        })
            
    return formats

def list_available_subtitles(url: str):
    info = _get_full_info_cached(url)
    if not info: return []
    
    subs = []
    manual_subs = info.get('subtitles', {})
    auto_subs = info.get('automatic_captions', {})
    video_lang = info.get('language')
    
    for lang_code in manual_subs.keys():
        subs.append({"code": lang_code, "name": f"{lang_code.upper()} (Manual)", "type": "manual"})
        
    if auto_subs:
        if video_lang and video_lang in auto_subs and video_lang not in manual_subs:
            subs.append({"code": video_lang, "name": f"{video_lang.upper()} (Auto)", "type": "auto"})
        if 'en' in auto_subs and 'en' not in manual_subs and video_lang != 'en':
            subs.append({"code": "en", "name": "EN (Auto)", "type": "auto"})
            
    return subs


def download_video_to_temp(url: str, task_id: str, max_resolution: int = 720, audio_only: bool = False, audio_format: str = 'mp3', sub_lang: str = None):
    temp_dir = tempfile.mkdtemp()
    
    try:
        # Define filename suffix
        suffix = ""
        if audio_only:
            suffix = f"({audio_format.upper()})"
        else:
            suffix = f"({max_resolution}p)"
            
        outtmpl = os.path.join(temp_dir, f'%(title)s {suffix}.%(ext)s')

        if audio_only:
            if audio_format == 'mp3':
                format_selector = 'bestaudio/best'
                postprocessors = [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}]
            elif audio_format == 'm4a':
                format_selector = 'bestaudio[ext=m4a]/bestaudio/best'
                postprocessors = []
            elif audio_format == 'webm':
                format_selector = 'bestaudio[ext=webm]/bestaudio/best'
                postprocessors = []
            else:
                format_selector = 'bestaudio/best'
                postprocessors = []
                
            merge_format = None
            out_ext = f'.{audio_format}'
        else:
            if max_resolution > 1080:
                format_selector = (f'bestvideo[height<={max_resolution}][vcodec^=vp9]+bestaudio/bestvideo[height<={max_resolution}]+bestaudio/best[height<={max_resolution}]')
                merge_format = 'mkv'
                out_ext = '.mkv'
            else:
                format_selector = f'bestvideo[height<={max_resolution}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<={max_resolution}]/best'
                merge_format = 'mp4'
                out_ext = '.mp4'
                
            postprocessors = []
            if sub_lang:
                postprocessors.extend([{'key': 'FFmpegSubtitlesConvertor', 'format': 'srt'}, {'key': 'FFmpegEmbedSubtitle'}])

        ydl_opts = _get_base_opts()
        ydl_opts.update({
            'format': format_selector,
            'outtmpl': outtmpl,
            'noplaylist': True,
            'progress_hooks': [lambda d: progress_hook(d, task_id)],
            'retries': 3,
            'fragment_retries': 3,
            'ignoreerrors': True,
        })
        
        if merge_format: ydl_opts['merge_output_format'] = merge_format
        if postprocessors: ydl_opts['postprocessors'] = postprocessors
        if sub_lang and not audio_only:
            ydl_opts['writesubtitles'] = True
            ydl_opts['writeautomaticsub'] = True
            ydl_opts['subtitleslangs'] = [sub_lang]

        # 1. Download to local container temp disk
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None: raise Exception("Failed to extract video.")
            
            filename = ydl.prepare_filename(info)
            if not os.path.exists(filename):
                filename = filename.rsplit('.', 1)[0] + out_ext
                
        actual_filename = os.path.basename(filename)
        
        # 2. Upload to Google Cloud Storage & Generate Signed URL
        gcs_url = upload_to_gcs(temp_dir, actual_filename)
        
        # Return the GCS URL instead of the local path!
        return temp_dir, actual_filename, gcs_url
        
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise e

def upload_to_gcs(local_dir, filename):
    """Uploads file to GCS and returns a 5-minute Signed URL using IAM SignBlob."""
    bucket_name = os.environ.get('GCS_BUCKET_NAME')
    if not bucket_name:
        raise Exception("GCS_BUCKET_NAME environment variable not set.")
        
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(filename)
    
    # Upload from local temp disk to GCS
    filepath = os.path.join(local_dir, filename)
    blob.upload_from_filename(filepath)
    
    # --- CLOUD RUN SIGNED URL FIX ---
    # Get the current application default credentials and force refresh the token
    credentials, project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if not credentials.valid:
        request = Request()
        credentials.refresh(request)
        
    # Extract the service account email from the credentials
    service_account_email = credentials.service_account_email
    if not service_account_email:
        # Fallback if email isn't in credentials (shouldn't happen on Cloud Run)
        service_account_email = os.environ.get('GCS_CLIENT_EMAIL')
        if not service_account_email:
            raise Exception("Could not determine service account email for signing.")

    # Generate Signed URL using IAM SignBlob API (Valid for 5 minutes)
    signed_url = blob.generate_signed_url(
        version="v4",
        expiration=datetime.timedelta(minutes=5),
        method="GET",
        service_account_email=service_account_email,
        access_token=credentials.token
    )
    
    return signed_url