import httpx
from fastapi.responses import StreamingResponse

async def stream_to_client(stream_url: str, filename: str, media_type: str = "video/mp4"):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }
    
    async with httpx.AsyncClient(follow_redirects=True) as client:
        # Get the file size first so the browser shows a proper download progress bar
        head_resp = await client.head(stream_url, headers=headers)
        total_size = head_resp.headers.get("content-length")
        
        async with client.stream("GET", stream_url, headers=headers) as response:
            if response.status_code != 200:
                raise Exception("Failed to fetch stream from YouTube")
            
            async def yield_chunks():
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    yield chunk

            return StreamingResponse(
                yield_chunks(),
                media_type=media_type,
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Content-Length": total_size or "",
                }
            )