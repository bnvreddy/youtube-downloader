import yt_dlp
import os
import tempfile
import re
import shutil

# Global dictionary to store download progress and states
download_tasks = {}

class DownloadCancelled(Exception):
    pass

# Regex to remove terminal color codes
ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

def clean_ytdlp_string(text):
    if not text: return ""
    text = ANSI_ESCAPE.sub('', text)
    text = text.replace('\r', '').replace('\n', '').strip()
    return text

def progress_hook(d, task_id):
    if download_tasks.get(task_id, {}).get('cancel_requested'):
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

        download_tasks[task_id]['progress'] = percent_value
        download_tasks[task_id]['speed'] = clean_speed if clean_speed else "N/A"
        download_tasks[task_id]['eta'] = clean_eta if clean_eta else "N/A"
        download_tasks[task_id]['status'] = 'downloading'
        download_tasks[task_id]['stream_type'] = stream_type
        
    elif d['status'] == 'finished':
        download_tasks[task_id]['progress'] = '100'
        download_tasks[task_id]['speed'] = ''
        download_tasks[task_id]['eta'] = ''
        download_tasks[task_id]['status'] = 'merging'
        download_tasks[task_id]['stream_type'] = ''

def get_video_info(url: str):
    ydl_opts = {
        'quiet': True,
        'extract_flat': True,
        'no_warnings': True,
        'skip_download': True,
        'remote_components': ['ejs:github'],
        # 'geo_bypass_country': 'US',
        'cookiefile': 'youtube_cookies.txt',
        # 'extractor_args': {'youtube': {'player_client': ['android']}},
        'proxy': "http://bywzztyc:rkafyc1ko1ds@38.58.9.4:6077/",
        'sleep_interval' : 3,
        'concurrent_fragment_downloads': 1
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
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
    """Dynamically fetches all available resolutions and calculates sizes"""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'remote_components': ['ejs:github'],
        # 'geo_bypass_country': 'US',
        'cookiefile': 'youtube_cookies.txt',
        # 'extractor_args': {'youtube': {'player_client': ['android']}},
        'proxy': "http://bywzztyc:rkafyc1ko1ds@38.58.9.4:6077/",
        'sleep_interval' : 3,
        'concurrent_fragment_downloads': 1
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if not info: return []
        
        duration = info.get('duration') # Video length in seconds
        formats = []
        seen_heights = set()
        
        # 1. Dynamically extract Video Resolutions
        for f in info.get('formats', []):
            height = f.get('height')
            vcodec = f.get('vcodec', 'none')
            
            # Only process formats that have video and a valid height
            if height and vcodec != 'none':
                # Only take the best format for each resolution (usually the first one yt-dlp lists)
                if height not in seen_heights:
                    seen_heights.add(height)
                    
                    # Calculate Size (YouTube hides exact sizes for 1080p+)
                    size = f.get('filesize') or f.get('filesize_approx')
                    if not size and duration and f.get('tbr'):
                        # Estimate size using Bitrate (tbr) and Duration, add 30% for audio + overhead
                        size = (f['tbr'] * 1000 / 8) * duration * 1.3
                    
                    size_mb = round(size / (1024 * 1024), 1) if size else "Unknown"
                    
                    # Generate nice labels
                    label = f"{height}p"
                    if height >= 2160: label = f"4K ({height}p)"
                    elif height >= 1440: label = f"2K ({height}p)"
                    
                    formats.append({
                        "id": f"video_{height}",
                        "label": f"{label} Video + Audio",
                        "size": f"~{size_mb} MB" if isinstance(size_mb, float) else size_mb,
                        "max_resolution": height,
                        "audio_only": False
                    })
        
        # Sort formats highest resolution first
        formats.sort(key=lambda x: x['max_resolution'], reverse=True)
        
        # 2. Extract Audio Only
        best_audio = next((f for f in info.get('formats', []) if f.get('acodec') != 'none' and f.get('vcodec') == 'none' and f.get('abr')), None)
        if best_audio or duration:
            size = best_audio.get('filesize') or best_audio.get('filesize_approx') if best_audio else None
            if not size and duration:
                # Estimate audio size based on standard 128kbps
                size = (128000 / 8) * duration 
            
            size_mb = round(size / (1024 * 1024), 1) if size else "Unknown"
            formats.append({
                "id": "audio_only",
                "label": "Audio Only (MP3)",
                "size": f"~{size_mb} MB" if isinstance(size_mb, float) else size_mb,
                "max_resolution": None,
                "audio_only": True
            })
            
        return formats


def list_available_subtitles(url: str):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'remote_components': ['ejs:github'],
        # 'geo_bypass_country': 'US',
        'cookiefile': 'youtube_cookies.txt',
        # 'extractor_args': {'youtube': {'player_client': ['android']}},
        'proxy': "http://bywzztyc:rkafyc1ko1ds@38.58.9.4:6077/",
        'sleep_interval' : 3,
        'concurrent_fragment_downloads': 1
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if not info: return []
        
        subs = []
        manual_subs = info.get('subtitles', {})
        auto_subs = info.get('automatic_captions', {})
        video_lang = info.get('language')
        
        for lang_code in manual_subs.keys():
            subs.append({"code": lang_code, "name": f"{lang_code.upper()} (Manual)", "type": "manual"})
            
        if auto_subs:
            if video_lang and video_lang in auto_subs:
                if video_lang not in manual_subs:
                    subs.append({"code": video_lang, "name": f"{video_lang.upper()} (Auto)", "type": "auto"})
            else:
                first_auto_lang = list(auto_subs.keys())[0]
                if first_auto_lang not in manual_subs:
                    subs.append({"code": first_auto_lang, "name": f"{first_auto_lang.upper()} (Auto)", "type": "auto"})
        return subs

def download_video_to_temp(url: str, task_id: str, max_resolution: int = 720, audio_only: bool = False, sub_lang: str = None):
    temp_dir = tempfile.mkdtemp()
    
    if audio_only:
        format_selector = 'bestaudio/best'
        merge_format = None
        postprocessors = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }]
        out_ext = '.mp3'
    else:
        # SMART CODEC & CONTAINER SELECTION:
        if max_resolution > 1080:
            # For 2K/4K, force VP9 codec (avoids unplayable AV1) and wrap in MKV. 
            # VP9 plays flawlessly on almost all hardware in VLC/Plex!
            # Fallback to any format if VP9 isn't available for that resolution.
            format_selector = (
                f'bestvideo[height<={max_resolution}][vcodec^=vp9]+bestaudio/'
                f'bestvideo[height<={max_resolution}]+bestaudio/'
                f'best[height<={max_resolution}]'
            )
            merge_format = 'mkv'
            out_ext = '.mkv'
        else:
            # For 1080p and below, force H.264 (avc1) inside an MP4 container.
            # Maximum compatibility for phones, older TVs, and browsers.
            format_selector = f'bestvideo[height<={max_resolution}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<={max_resolution}]/best'
            merge_format = 'mp4'
            out_ext = '.mp4'
            
        postprocessors = []
        
        # Add subtitle embedding options if a language is provided
        if sub_lang:
            postprocessors.extend([
                {'key': 'FFmpegSubtitlesConvertor', 'format': 'srt'},
                {'key': 'FFmpegEmbedSubtitle'},
            ])

    ydl_opts = {
        'format': format_selector,
        'outtmpl': os.path.join(temp_dir, '%(title)s.%(ext)s'),
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'remote_components': ['ejs:github'],
        'progress_hooks': [lambda d: progress_hook(d, task_id)],
        'retries': 3,
        'fragment_retries': 3,
        # 'geo_bypass_country': 'US',
        'cookiefile': 'youtube_cookies.txt',
        # 'extractor_args': {'youtube': {'player_client': ['android']}},
        'proxy': "http://bywzztyc:rkafyc1ko1ds@38.58.9.4:6077/",
        'sleep_interval' : 3,
        'concurrent_fragment_downloads': 1
    }
    
    if merge_format: 
        ydl_opts['merge_output_format'] = merge_format
    if postprocessors: 
        ydl_opts['postprocessors'] = postprocessors
        
    if sub_lang and not audio_only:
        ydl_opts['writesubtitles'] = True
        ydl_opts['writeautomaticsub'] = True
        ydl_opts['subtitleslangs'] = [sub_lang]

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None: raise Exception("Failed to extract video.")
        
        filename = ydl.prepare_filename(info)
        if not os.path.exists(filename):
            filename = filename.rsplit('.', 1)[0] + out_ext
            
    actual_filename = os.path.basename(filename)
    return temp_dir, filename, actual_filename