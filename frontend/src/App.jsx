import { useState, useEffect, useRef } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || "http://192.168.1.4:8000";
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

  // --- INDETERMINATE LOGIC ---
  const selectAllRef = useRef(null);
  const isAllSelected = videos.length > 0 && selectedVideos.size === videos.length;
  const isPartial = selectedVideos.size > 0 && selectedVideos.size < videos.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPartial;
    }
  }, [isPartial]);

  const toggleSelectAll = () => {
    // If fully selected OR partially selected, deselect all. Otherwise, select all.
    if (isAllSelected || isPartial) {
      setSelectedVideos(new Set());
    } else {
      setSelectedVideos(new Set(videos.map(v => v.id)));
    }
  };
  // ---------------------------

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
        setPlaylistQueue(prev => ({ ...prev, title: "⏳ Waiting 5s to prevent rate-limit..." }));
        await sleep(5000);
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

  // Dynamic text for the select all checkbox
  const getSelectAllText = () => {
    if (isAllSelected) return `Deselect All (${videos.length})`;
    if (isPartial) return `Select All (${selectedVideos.size}/${videos.length})`;
    return `Select All (${videos.length})`;
  };

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-white flex flex-col items-center p-4 md:p-8">
      
      {/* HEADER */}
      <div className="flex items-center justify-center gap-2 md:gap-4 mb-1 md:mb-2 mt-4 md:mt-8">
        <svg className="w-10 h-10 md:w-14 md:h-14 drop-shadow-[0_0_10px_rgba(255,0,0,0.6)]" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          {/* Red Background */}
          <rect width="100" height="100" rx="20" fill="#FF0000"/>
          {/* Solid White Down Arrow */}
          <path d="M40 15 L60 15 L60 55 L75 55 L50 85 L25 55 L40 55 Z" fill="white"/>
          {/* Red Play Button cut-out inside the Arrow */}
          <polygon points="47,28 47,48 58,38" fill="#FF0000"/>
        </svg>
        <h1 className="text-3xl md:text-6xl font-extrabold text-white tracking-tight">
          YouTube <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-red-800">Downloader</span>
        </h1>
      </div>
      <p className="text-[#AAAAAA] mb-8 md:mb-12 text-xs md:text-base font-medium tracking-wider uppercase">Personal Use • High Quality • Fast Proxy Support</p>

      {/* INPUT SECTION */}
      <div className="w-full max-w-2xl flex flex-col md:flex-row gap-3 md:gap-4 mb-8">
        <input 
          type="text" placeholder="Paste Video or Playlist URL..." 
          className="flex-1 p-4 rounded-xl bg-[#121212] border border-[#282828] focus:border-red-500 focus:ring-2 focus:ring-red-500/50 focus:outline-none transition-all placeholder-[#555555] text-sm md:text-base shadow-lg shadow-black/50"
          value={url} onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={fetchInfo} disabled={loading}
          className="bg-gradient-to-r from-red-600 to-red-800 hover:from-red-500 hover:to-red-700 px-8 py-4 rounded-xl font-bold transition-all disabled:opacity-50 text-sm md:text-base shadow-[0_0_20px_rgba(255,0,0,0.3)] hover:shadow-[0_0_25px_rgba(255,0,0,0.6)]"
        > {loading ? '⏳ Fetching...' : '🔍 Fetch Info'} </button>
      </div>

      {error && <p className="text-red-400 mb-4 bg-red-900/30 px-6 py-3 rounded-lg border border-red-800/50 text-xs md:text-base backdrop-blur-sm">{error}</p>}

      {/* EMPTY STATE */}
      {videos.length === 0 && !loading && (
        <div className="mt-20 flex flex-col items-center text-[#444444]">
          <svg className="w-24 h-24 mb-4 opacity-30" fill="currentColor" viewBox="0 0 24 24"><path d="M10 16l5-4-5-4v8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
          <p className="text-xl font-semibold">Paste a link to get started</p>
          <p className="text-sm mt-2">Supports Videos, Playlists & Subtitles</p>
        </div>
      )}

      {/* PLAYLIST SECTION */}
      {videos.length > 1 && (
        <div className="w-full max-w-4xl mb-6 bg-[#1a1a1a] p-5 md:p-6 rounded-2xl border border-[#282828] shadow-2xl transition-all duration-300">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4">
            <div className="flex items-center gap-3">
              <input 
                ref={selectAllRef}
                type="checkbox" 
                checked={isAllSelected}
                onChange={toggleSelectAll}
                className="w-5 h-5 rounded bg-[#121212] border-[#303030] text-red-600 focus:ring-red-500 cursor-pointer transition-all"
              />
              <span className="font-semibold text-[#F1F1F1] text-sm md:text-base">{getSelectAllText()}</span>
            </div>
            <button onClick={runPlaylistDownload} disabled={isDownloadingPlaylist || selectedVideos.size === 0}
              className="w-full md:w-auto bg-gradient-to-r from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-600 text-black px-6 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50 text-sm md:text-base shadow-[0_0_15px_rgba(59,165,255,0.2)]"
            > {isDownloadingPlaylist ? '⏳ Processing Queue...' : `⬇ Download Selected (${selectedVideos.size})`} </button>
          </div>
          {isDownloadingPlaylist && (
            <div className="mt-2">
              <div className="flex justify-between text-xs md:text-sm text-white mb-1">
                <span className="font-medium truncate mr-4">📹 {playlistQueue.title}</span>
                <span className="text-[#AAAAAA] whitespace-nowrap">{playlistQueue.current} / {playlistQueue.total}</span>
              </div>
              <div className="bg-[#121212] rounded-full h-3 w-full overflow-hidden">
                <div className="bg-gradient-to-r from-red-500 to-red-700 h-full rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${(playlistQueue.current / playlistQueue.total) * 100}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIDEO CARDS */}
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {videos.map((video) => (
          <div key={video.id} className={`bg-[#1a1a1a] rounded-2xl overflow-hidden shadow-xl border transition-all duration-300 ease-out flex flex-col transform hover:scale-[1.02] ${selectedVideos.has(video.id) ? 'border-red-600/70 shadow-[0_0_25px_rgba(255,0,0,0.15)]' : 'border-[#282828] opacity-80 hover:opacity-100'}`}>
            
            <div className="relative group">
              {video.thumbnail && <img src={video.thumbnail} alt={video.title} className="w-full h-40 md:h-52 object-cover transition-opacity duration-300 group-hover:opacity-80" />}
              {videos.length > 1 && (
                <input type="checkbox" checked={selectedVideos.has(video.id)} onChange={() => toggleSelect(video.id)}
                  className="absolute top-3 left-3 w-6 h-6 rounded bg-black/60 border-[#303030] text-red-600 focus:ring-red-500 cursor-pointer backdrop-blur-sm transition-transform duration-200 hover:scale-125"
                />
              )}
            </div>

            <div className="p-4 md:p-5 flex-1 flex flex-col">
              <h3 className="text-sm md:text-base font-semibold mb-3 line-clamp-2 text-[#F1F1F1]">{video.title}</h3>
              
              {downloadProgress[video.id] && (
                <div className="mb-4">
                  <div className="flex justify-between text-[10px] md:text-xs text-[#AAAAAA] mb-1">
                    <span>
                      {downloadProgress[video.id].status === 'completed' ? (
                        <span className="text-green-400 font-bold">✅ Completed!</span>
                      ) : downloadProgress[video.id].status === 'cancelled' ? (
                        <span className="text-red-500 font-bold">🚫 Cancelled</span>
                      ) : downloadProgress[video.id].status === 'starting' ? (
                        <span className="animate-pulse text-blue-400">⏳ Initializing...</span>
                      ) : downloadProgress[video.id].status === 'merging' ? (
                        <span className="animate-pulse text-purple-400">🔄 Merging audio & video...</span>
                      ) : (
                        <span className="text-blue-300">Downloading {downloadProgress[video.id].stream_type || ''}... {downloadProgress[video.id].speed || ''}</span>
                      )}
                    </span>
                    <span className="font-mono">{downloadProgress[video.id].progress}%</span>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-[#121212] rounded-full h-2.5 md:h-3 w-full overflow-hidden border border-[#282828]">
                      <div className={`h-full rounded-full transition-all duration-700 ease-out ${
                          downloadProgress[video.id].status === 'completed' ? 'bg-gradient-to-r from-green-400 to-green-600' :
                          downloadProgress[video.id].status === 'cancelled' ? 'bg-red-500' :
                          downloadProgress[video.id].stream_type === 'Subtitle/Convert' ? 'bg-yellow-500' : 
                          downloadProgress[video.id].stream_type === 'Audio' ? 'bg-[#3EA6FF]' : 'bg-gradient-to-r from-red-500 to-red-700'
                      }`}
                        style={{ width: `${downloadProgress[video.id].progress || 0}%` }}
                      ></div>
                    </div>
                    
                    {(downloadProgress[video.id].status === 'downloading' || downloadProgress[video.id].status === 'merging' || downloadProgress[video.id].status === 'starting') && (
                      <button 
                        onClick={() => cancelDownload(video.id)}
                        className="bg-[#121212] border border-[#282828] hover:bg-red-900 hover:border-red-700 text-[#AAAAAA] hover:text-white text-[10px] md:text-xs font-bold p-1 md:px-2 md:py-1 rounded transition-colors"
                        title="Cancel"
                      > ✕ </button>
                    )}
                  </div>
                  
                  {downloadProgress[video.id].eta && downloadProgress[video.id].status === 'downloading' && (
                    <p className="text-[10px] md:text-xs text-[#555555] mt-1 text-right">ETA: {downloadProgress[video.id].eta}</p>
                  )}
                </div>
              )}

              <button 
                onClick={() => fetchVideoSettings(video.url, video.id)}
                className="text-[#3EA6FF] hover:text-[#65B8FF] transition-colors mb-3 flex items-center gap-1 font-medium text-xs md:text-sm mt-auto"
              > ⚙️ Quality & Subtitles </button>

              {videoSettings[video.id]?.visible && (
                <div className="bg-[#121212] p-3 md:p-4 rounded-xl mb-3 border border-[#282828] shadow-inner transition-all duration-300">
                  {videoSettings[video.id].loading ? (
                    <p className="text-xs text-[#555555] animate-pulse">Loading options...</p>
                  ) : (
                    <>
                      <div className="mb-3">
                        <p className="text-[10px] md:text-xs text-[#555555] font-bold mb-1 uppercase tracking-wider">Format</p>
                        {videoSettings[video.id].formats.map(fmt => (
                          <label key={fmt.id} className="flex items-center justify-between p-1.5 md:p-2 hover:bg-[#1a1a1a] rounded-lg cursor-pointer transition-colors">
                            <div className="flex items-center gap-2">
                              <input type="radio" name={`format-${video.id}`} 
                                checked={selectedFormats[video.id]?.id === fmt.id}
                                onChange={() => setSelectedFormats(prev => ({ ...prev, [video.id]: fmt }))}
                                className="text-red-600 focus:ring-red-500"
                              />
                              <span className="text-xs md:text-sm text-[#F1F1F1]">{fmt.label}</span>
                            </div>
                            <span className="text-[10px] md:text-xs text-[#555555] font-mono">{fmt.size}</span>
                          </label>
                        ))}
                      </div>

                      {videoSettings[video.id].subs.length > 0 && !selectedFormats[video.id]?.audio_only && (
                        <div>
                          <p className="text-[10px] md:text-xs text-[#555555] font-bold mb-1 uppercase tracking-wider">Subtitle (Embedded)</p>
                          <select className="w-full bg-[#1a1a1a] border border-[#282828] text-xs md:text-sm rounded-lg p-2 text-white focus:border-blue-500 focus:outline-none transition-colors"
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
                  className={`w-full py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2 mt-auto text-sm md:text-base shadow-lg ${
                    downloadProgress[video.id]?.status === 'completed' 
                      ? 'bg-gradient-to-r from-green-500 to-green-700 shadow-[0_0_20px_rgba(0,255,0,0.2)]' 
                      : (downloadProgress[video.id]?.status === 'downloading' || downloadProgress[video.id]?.status === 'merging' || downloadProgress[video.id]?.status === 'starting')
                      ? 'bg-[#282828] cursor-wait text-[#555555] shadow-none'
                      : 'bg-gradient-to-r from-red-600 to-red-800 hover:from-red-500 hover:to-red-700 shadow-[0_0_20px_rgba(255,0,0,0.3)] hover:shadow-[0_0_25px_rgba(255,0,0,0.6)]'
                  }`}
                > 
                  {downloadProgress[video.id]?.status === 'completed' 
                    ? '✅ Done' 
                    : (downloadProgress[video.id]?.status === 'downloading' || downloadProgress[video.id]?.status === 'merging' || downloadProgress[video.id]?.status === 'starting')
                    ? <span className="animate-pulse">⚙️ Processing...</span> 
                    : <span>⬇ Download {selectedFormats[video.id]?.label || '720p'}</span>
                  } 
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* FOOTER */}
      <footer className="w-full max-w-4xl mt-16 pt-6 border-t border-[#282828] flex flex-col md:flex-row justify-between items-center text-[#555555] text-xs md:text-sm pb-8 px-4">
        <div className="flex items-center gap-2 mb-4 md:mb-0">
          <span className="text-[#AAAAAA]">Built with ❤️ by</span>
          <span className="font-bold text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-purple-500 text-base">Naga</span>
        </div>
        
        <div className="flex items-center gap-6">
          <a href="https://github.com/bnvreddy/youtube-downloader" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center gap-2 group">
            <svg className="w-5 h-5 group-hover:fill-white transition-colors" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            <span className="group-hover:text-white">GitHub</span>
          </a>
          <span className="text-[#333333]">|</span>
          <span className="opacity-70">Educational Use Only</span>
        </div>
      </footer>

    </div>
  )
}

export default App