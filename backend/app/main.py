import shutil
import os
import threading
import time
import uuid
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from app.services.extractor import DownloadCancelled, get_video_info, download_video_to_temp, list_available_subtitles, list_available_formats, download_tasks
from pydantic import BaseModel



app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class InfoRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    url: str
    sub_lang: Optional[str] = None
    max_resolution: Optional[int] = 720
    audio_only: Optional[bool] = False
    audio_format: Optional[str] = "mp3"

def delayed_cleanup(temp_dir: str, delay: int = 30):
    def cleanup():
        time.sleep(delay)
        try: shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception as e: print(f"Error cleaning up {temp_dir}: {e}")
    thread = threading.Thread(target=cleanup)
    thread.start()

@app.post("/api/info")
async def fetch_info(request: InfoRequest):
    try:
        videos = get_video_info(request.url)
        return {"videos": videos}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/list-subs")
async def list_subs(request: InfoRequest):
    try:
        subs = list_available_subtitles(request.url)
        return {"subtitles": subs}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/list-formats")
async def fetch_formats(request: InfoRequest):
    try:
        formats = list_available_formats(request.url)
        return {"formats": formats}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/start-download")
async def start_download(request: DownloadRequest):
    task_id = str(uuid.uuid4())
    download_tasks[task_id] = {
        "status": "starting",
        "progress": "0",
        "speed": "",
        "eta": "",
        "filepath": None,
        "filename": None,
        "temp_dir": None,
        "stream_type": ""
    }
    
    def run():
        try:
            temp_dir, filepath, filename = download_video_to_temp(
                request.url, task_id, request.max_resolution, request.audio_only, request.audio_format,request.sub_lang
            )
            download_tasks[task_id]['filepath'] = filepath
            download_tasks[task_id]['filename'] = filename
            download_tasks[task_id]['temp_dir'] = temp_dir
            download_tasks[task_id]['status'] = 'completed'
        except DownloadCancelled:
            temp_dir = download_tasks[task_id].get('temp_dir')
            if temp_dir and os.path.exists(temp_dir):
                shutil.rmtree(temp_dir, ignore_errors=True)
            download_tasks[task_id]['status'] = 'cancelled'
        except Exception as e:
            download_tasks[task_id]['status'] = f'error: {str(e)}'

    thread = threading.Thread(target=run)
    thread.start()
    
    return {"task_id": task_id}

@app.post("/api/cancel-download/{task_id}")
async def cancel_download(task_id: str):
    if task_id in download_tasks:
        download_tasks[task_id]['cancel_requested'] = True
        return {"message": "Cancel requested"}
    raise HTTPException(status_code=404, detail="Task not found")

@app.get("/api/progress/{task_id}")
async def get_progress(task_id: str):
    if task_id in download_tasks:
        return download_tasks[task_id]
    return {"status": "not_found"}

@app.get("/api/get-file/{task_id}")
async def get_file(task_id: str):
    if task_id not in download_tasks or download_tasks[task_id]['status'] != 'completed':
        raise HTTPException(status_code=404, detail="File not ready")
    
    task = download_tasks[task_id]
    delayed_cleanup(task['temp_dir'], delay=30)
    
    return FileResponse(
        path=task['filepath'], 
        filename=task['filename'], 
        media_type='application/octet-stream'
    )
