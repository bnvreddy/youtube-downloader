import { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || "http://192.168.10.4:8000";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function App() {
  const [url, setUrl] = useState('');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [downloadProgress, setDownloadProgress] = useState({});
  const [videoSettings, setVideoSettings] = useState({});
  const [selectedFormats, setSelectedFormats] = useState({});
  const [selectedSubs, setSelectedSubs] = useState({});
  const [activeTaskIds, setActiveTaskIds] = useState({});
  
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [isDownloadingPlaylist, setIsDownloadingPlaylist] = useState(false);
  const [playlistQueue, setPlaylistQueue] = useState({ current: 0, total: 0, title: '' });

  useEffect(() => {
    if (videos.length > 0) setSelectedVideos(new Set(videos.map(v => v.id)));
  }, [videos]);

  const fetchInfo = async () => {
    if (!url) return;
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_BASE}/api/info`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error fetching info');
      setVideos(data.videos);
    } catch (err) { setError(err.message); } 
    finally { setLoading(false); }
  };

  const fetchVideoSettings = async (videoUrl, videoId) => {
    if (videoSettings[videoId]?.visible) {
      setVideoSettings(prev => ({ ...prev, [videoId]: { ...prev[videoId], visible: false } }));
      return;
    }
    setVideoSettings(prev => ({ ...prev, [videoId]: { visible: true, loading: true, formats: [], subs: [] } }));

    let formats = [];
    let subs = [];

    try {
      const fmtRes = await fetch(`${API_BASE}/api/list-formats`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, body: JSON.stringify({ url: videoUrl }) });
      if (fmtRes.ok) { const fmtData = await fmtRes.json(); formats = fmtData.formats || []; }
    } catch (err) { console.error("Format fetch error:", err); }

    try {
      const subRes = await fetch(`${API_BASE}/api/list-subs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, body: JSON.stringify({ url: videoUrl }) });
      if (subRes.ok) { const subData = await subRes.json(); subs = subData.subtitles || []; }
    } catch (err) { console.error("Sub fetch error:", err); }

    const defaultFormat = formats.find(f => f.id === 'video_720') || formats[0];
    if (defaultFormat) setSelectedFormats(prev => ({ ...prev, [videoId]: defaultFormat }));

    setVideoSettings(prev => ({ ...prev, [videoId]: { visible: true, loading: false, formats, subs } }));
  };

  const toggleSelect = (id) => {
    setSelectedVideos(prev => { const n = new Set(prev); if(n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const toggleSelectAll = () => {
    setSelectedVideos(prev => prev.size === videos.length ? new Set() : new Set(videos.map(v => v.id)));
  };

  const triggerDownload = (downloadUrl) => {
    const a = document.createElement('a');
    a.href = downloadUrl; a.style.display = 'none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const cancelDownload = async (videoId) => {
    const task_id = activeTaskIds[videoId];
    if (task_id) {
      try { await fetch(`${API_BASE}/api/cancel-download/${task_id}`, { method: 'POST' }); } 
      catch (err) { console.error("Failed to send cancel request", err); }
    }
  };

  const downloadAndAwaitVideo = (videoUrl, videoId) => {
    return new Promise((resolve, reject) => {
      const formatData = selectedFormats[videoId] || { max_resolution: 720, audio_only: false };
      const requestBody = { 
        url: videoUrl, sub_lang: selectedSubs[videoId] || null,
        max_resolution: formatData.max_resolution, audio_only: formatData.audio_only
      };

      fetch(`${API_BASE}/api/start-download`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify(requestBody)
      })
      .then(res => res.json())
      .then(data => {
        const task_id = data.task_id;
        setActiveTaskIds(prev => ({ ...prev, [videoId]: task_id }));

        const interval = setInterval(async () => {
          try {
            const progRes = await fetch(`${API_BASE}/api/progress/${task_id}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
            const progData = await progRes.json();
            
            setDownloadProgress(prev => ({ ...prev, [videoId]: progData }));

            if (progData.status === 'completed') {
              clearInterval(interval);
              setDownloadProgress(prev => ({ ...prev, [videoId]: { status: 'completed', progress: '100', speed: '', eta: '', stream_type: '' } }));
              triggerDownload(`${API_BASE}/api/get-file/${task_id}`);
              setTimeout(() => {
                setDownloadProgress(prev => ({ ...prev, [videoId]: null }));
                setActiveTaskIds(prev => ({ ...prev, [videoId]: null }));
                resolve();
              }, 2500);
            } else if (progData.status === 'cancelled') {
              clearInterval(interval);
              setDownloadProgress(prev => ({ ...prev, [videoId]: { status: 'cancelled', progress: '0' } }));
              setTimeout(() => {
                setDownloadProgress(prev => ({ ...prev, [videoId]: null }));
                setActiveTaskIds(prev => ({ ...prev, [videoId]: null }));
                reject("cancelled");
              }, 1500);
            } else if (progData.status.startsWith('error')) {
              clearInterval(interval);
              setDownloadProgress(prev => ({ ...prev, [videoId]: null }));
              setActiveTaskIds(prev => ({ ...prev, [videoId]: null }));
              reject(progData.status);
            }
          } catch (err) { clearInterval(interval); reject(err); }
        }, 1000);
      })
      .catch(reject);
    });
  };

    const runPlaylistDownload = async () => {
    const videosToDownload = videos.filter(v => selectedVideos.has(v.id));
    if (videosToDownload.length === 0) return alert("No videos selected!");
    setIsDownloadingPlaylist(true);
    
    for (let i = 0; i < videosToDownload.length; i++) {
      const video = videosToDownload[i];
      setPlaylistQueue({ current: i + 1, total: videosToDownload.length, title: video.title });
      try { 
        await downloadAndAwaitVideo(video.url, video.id); 
      } catch (err) { 
        if (err === "cancelled") { break; }
        console.error(`Failed to download ${video.title}:`, err); 
      }

      if (i < videosToDownload.length - 1) {
        setPlaylistQueue(prev => ({ 
          ...prev, 
          title: "⏳ Waiting 5s to prevent rate-limit..." 
        }));
        await sleep(5000); // 5000 milliseconds = 5 seconds
      }

    }
    
    setIsDownloadingPlaylist(false);
    setPlaylistQueue({ current: 0, total: 0, title: '' });
  };

  const downloadSingleVideo = async (videoUrl, videoId) => {
    setDownloadProgress(prev => ({ ...prev, [videoId]: { status: 'starting', progress: '0', stream_type: '' } }));
    try { await downloadAndAwaitVideo(videoUrl, videoId); } 
    catch (err) { if (err !== "cancelled") alert("Download failed: " + err); }
  };

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-white flex flex-col items-center p-4 md:p-8">
      <div className="flex items-center justify-center gap-2 md:gap-4 mb-1 md:mb-2">
        <svg className="w-8 h-8 md:w-12 md:h-12 drop-shadow-lg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" rx="20" fill="#FF0000"/>
          <polygon points="35,25 35,75 75,50" fill="#FFFFFF"/>
          <path d="M 80 65 L 80 90 L 70 90 L 85 100 L 100 90 L 90 90 L 90 65 Z" fill="#282828"/>
        </svg>
        <h1 className="text-2xl md:text-5xl font-extrabold text-white tracking-tight">
          YouTube <span className="text-red-600">Downloader</span>
        </h1>
      </div>
      <p className="text-[#AAAAAA] mb-6 md:mb-10 text-xs md:text-base font-medium">Personal use • Any Quality • Size Estimates</p>

      <div className="w-full max-w-2xl flex flex-col md:flex-row gap-3 md:gap-4 mb-6 md:mb-8">
        <input 
          type="text" placeholder="Paste Video or Playlist URL..." 
          className="flex-1 p-3 md:p-4 rounded-lg bg-[#121212] border border-[#303030] focus:border-red-600 focus:ring-1 focus:ring-red-600 focus:outline-none transition-all placeholder-[#717171] text-sm md:text-base"
          value={url} onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={fetchInfo} disabled={loading}
          className="bg-red-600 hover:bg-red-700 px-6 py-3 md:py-4 rounded-lg font-bold transition-colors disabled:opacity-50 text-sm md:text-base shadow-lg"
        > {loading ? 'Fetching...' : 'Fetch Info'} </button>
      </div>

      {error && <p className="text-red-500 mb-4 bg-red-900/20 px-4 py-2 rounded-lg border border-red-800/30 text-xs md:text-base">{error}</p>}

      {videos.length > 1 && (
        <div className="w-full max-w-4xl mb-6 bg-[#212121] p-4 md:p-5 rounded-xl border border-[#303030] shadow-xl">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4">
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={selectedVideos.size === videos.length} onChange={toggleSelectAll}
                className="w-5 h-5 rounded bg-[#121212] border-[#303030] text-red-600 focus:ring-red-500 cursor-pointer"
              />
              <span className="font-semibold text-[#F1F1F1] text-sm md:text-base">Select All ({videos.length} videos)</span>
            </div>
            <button onClick={runPlaylistDownload} disabled={isDownloadingPlaylist || selectedVideos.size === 0}
              className="w-full md:w-auto bg-[#3EA6FF] hover:bg-[#65B8FF] text-black px-5 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50 text-sm md:text-base"
            > {isDownloadingPlaylist ? 'Processing Queue...' : `⬇ Download Selected (${selectedVideos.size})`} </button>
          </div>
          {isDownloadingPlaylist && (
            <div className="mt-2">
              <div className="flex justify-between text-xs md:text-sm text-white mb-1">
                <span className="font-medium truncate mr-4">📹 {playlistQueue.title}</span>
                <span className="text-[#AAAAAA] whitespace-nowrap">{playlistQueue.current} / {playlistQueue.total}</span>
              </div>
              <div className="bg-[#121212] rounded-full h-3 w-full overflow-hidden">
                <div className="bg-red-600 h-full rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${(playlistQueue.current / playlistQueue.total) * 100}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        {videos.map((video) => (
          <div key={video.id} className={`bg-[#212121] rounded-xl overflow-hidden shadow-xl border transition-all flex flex-col ${selectedVideos.has(video.id) ? 'border-red-600/70 shadow-red-900/10' : 'border-[#303030] opacity-70'}`}>
            
            <div className="relative">
              {video.thumbnail && <img src={video.thumbnail} alt={video.title} className="w-full h-36 md:h-48 object-cover" />}
              {videos.length > 1 && (
                <input type="checkbox" checked={selectedVideos.has(video.id)} onChange={() => toggleSelect(video.id)}
                  className="absolute top-3 left-3 w-6 h-6 rounded bg-black/60 border-[#303030] text-red-600 focus:ring-red-500 cursor-pointer backdrop-blur-sm"
                />
              )}
            </div>

            <div className="p-3 md:p-4 flex-1 flex flex-col">
              <h3 className="text-sm md:text-base font-semibold mb-3 line-clamp-2 text-[#F1F1F1]">{video.title}</h3>
              
              {downloadProgress[video.id] && (
                <div className="mb-4">
                  <div className="flex justify-between text-[10px] md:text-xs text-[#AAAAAA] mb-1">
                    <span>
                      {downloadProgress[video.id].status === 'completed' ? (
                        <span className="text-green-400 font-semibold">✅ Completed!</span>
                      ) : downloadProgress[video.id].status === 'cancelled' ? (
                        <span className="text-red-500 font-semibold">🚫 Cancelled</span>
                      ) : downloadProgress[video.id].status === 'starting' ? (
                        <span>Initializing...</span>
                      ) : downloadProgress[video.id].status === 'merging' ? (
                        <span>Merging audio & video...</span>
                      ) : (
                        <span>Downloading {downloadProgress[video.id].stream_type || ''}... {downloadProgress[video.id].speed || ''}</span>
                      )}
                    </span>
                    <span>{downloadProgress[video.id].progress}%</span>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-[#121212] rounded-full h-2 md:h-2.5 w-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ease-out ${
                          downloadProgress[video.id].status === 'completed' ? 'bg-green-400' :
                          downloadProgress[video.id].status === 'cancelled' ? 'bg-red-500' :
                          downloadProgress[video.id].stream_type === 'Subtitle/Convert' ? 'bg-yellow-500' : 
                          downloadProgress[video.id].stream_type === 'Audio' ? 'bg-[#3EA6FF]' : 'bg-red-600'
                      }`}
                        style={{ width: `${downloadProgress[video.id].progress || 0}%` }}
                      ></div>
                    </div>
                    
                    {(downloadProgress[video.id].status === 'downloading' || downloadProgress[video.id].status === 'merging' || downloadProgress[video.id].status === 'starting') && (
                      <button 
                        onClick={() => cancelDownload(video.id)}
                        className="bg-[#212121] border border-[#303030] hover:bg-red-900 hover:border-red-700 text-[#AAAAAA] hover:text-white text-[10px] md:text-xs font-bold p-1 md:px-2 md:py-1 rounded transition-colors"
                        title="Cancel"
                      > ✕ </button>
                    )}
                  </div>
                  
                  {downloadProgress[video.id].eta && downloadProgress[video.id].status === 'downloading' && (
                    <p className="text-[10px] md:text-xs text-[#717171] mt-1 text-right">ETA: {downloadProgress[video.id].eta}</p>
                  )}
                </div>
              )}

              <button 
                onClick={() => fetchVideoSettings(video.url, video.id)}
                className="text-[#3EA6FF] hover:text-[#65B8FF] transition-colors mb-3 flex items-center gap-1 font-medium text-xs md:text-sm"
              > ⚙️ Quality & Subtitles </button>

              {videoSettings[video.id]?.visible && (
                <div className="bg-[#0F0F0F] p-2 md:p-3 rounded-lg mb-3 border border-[#303030]">
                  {videoSettings[video.id].loading ? (
                    <p className="text-xs text-[#AAAAAA] animate-pulse">Loading options...</p>
                  ) : (
                    <>
                      <div className="mb-3">
                        <p className="text-[10px] md:text-xs text-[#717171] font-bold mb-1 uppercase tracking-wider">Format</p>
                        {videoSettings[video.id].formats.map(fmt => (
                          <label key={fmt.id} className="flex items-center justify-between p-1 md:p-1.5 hover:bg-[#121212] rounded cursor-pointer">
                            <div className="flex items-center gap-2">
                              <input type="radio" name={`format-${video.id}`} 
                                checked={selectedFormats[video.id]?.id === fmt.id}
                                onChange={() => setSelectedFormats(prev => ({ ...prev, [video.id]: fmt }))}
                                className="text-red-600 focus:ring-red-500"
                              />
                              <span className="text-xs md:text-sm text-[#F1F1F1]">{fmt.label}</span>
                            </div>
                            <span className="text-[10px] md:text-xs text-[#717171] font-mono">{fmt.size}</span>
                          </label>
                        ))}
                      </div>

                      {videoSettings[video.id].subs.length > 0 && !selectedFormats[video.id]?.audio_only && (
                        <div>
                          <p className="text-[10px] md:text-xs text-[#717171] font-bold mb-1 uppercase tracking-wider">Subtitle (Embedded)</p>
                          <select className="w-full bg-[#121212] border border-[#303030] text-xs md:text-sm rounded-md p-1.5 text-white focus:border-red-500 focus:outline-none"
                            value={selectedSubs[video.id] || ""} onChange={(e) => setSelectedSubs(prev => ({ ...prev, [video.id]: e.target.value }))}
                          >
                            <option value="">No Subtitle</option>
                            {videoSettings[video.id].subs.map(sub => ( <option key={sub.code} value={sub.code}>{sub.name}</option> ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {videos.length <= 1 && (
                <button onClick={() => downloadSingleVideo(video.url, video.id)} 
                  disabled={downloadProgress[video.id]?.status === 'downloading' || downloadProgress[video.id]?.status === 'merging' || downloadProgress[video.id]?.status === 'starting'}
                  className={`w-full py-2 rounded-lg font-bold transition-all flex items-center justify-center gap-2 mt-auto text-xs md:text-sm shadow-lg ${
                    downloadProgress[video.id]?.status === 'completed' 
                      ? 'bg-green-600 hover:bg-green-500 shadow-green-500/20' 
                      : (downloadProgress[video.id]?.status === 'downloading' || downloadProgress[video.id]?.status === 'merging' || downloadProgress[video.id]?.status === 'starting')
                      ? 'bg-[#303030] cursor-wait text-[#717171] shadow-none'
                      : 'bg-red-600 hover:bg-red-700 shadow-red-500/20'
                  }`}
                > 
                  {downloadProgress[video.id]?.status === 'completed' 
                    ? '✅ Done' 
                    : (downloadProgress[video.id]?.status === 'downloading' || downloadProgress[video.id]?.status === 'merging' || downloadProgress[video.id]?.status === 'starting')
                    ? <span className="animate-pulse">Processing...</span> 
                    : <span>⬇ Download {selectedFormats[video.id]?.label || '720p'}</span>
                  } 
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App