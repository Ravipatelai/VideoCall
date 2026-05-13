import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

const socket = io("http://localhost:5000");

const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function VideoCall() {
  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef({});
  const peerConnectionsRef = useRef({});
  const localStreamRef = useRef(null);
  const pendingIceCandidatesRef = useRef({});
  
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");
  const [joined, setJoined] = useState(false);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);

  const generateRoomCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  useEffect(() => {
    socket.on("user-joined", handleUserJoined);
    socket.on("all-users", handleAllUsers);
    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("user-disconnected", handleUserDisconnected);

    return () => {
      socket.off("user-joined");
      socket.off("all-users");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("user-disconnected");
      
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
    };
  }, []);

  const handleUserJoined = async (userId) => {
    if (localStreamRef.current && !peerConnectionsRef.current[userId]) {
      setRemoteUsers(prev => prev.includes(userId) ? prev : [...prev, userId]);
      setTimeout(() => createPeerConnection(userId, true), 200);
    }
  };

  const handleAllUsers = async (users) => {
    for (const userId of users) {
      if (userId !== socket.id && !peerConnectionsRef.current[userId]) {
        setRemoteUsers(prev => prev.includes(userId) ? prev : [...prev, userId]);
        setTimeout(() => createPeerConnection(userId, true), 200);
      }
    }
  };

  const handleOffer = async ({ offer, from }) => {
    setRemoteUsers(prev => prev.includes(from) ? prev : [...prev, from]);
    
    setTimeout(async () => {
      if (!peerConnectionsRef.current[from]) {
        await createPeerConnection(from, false);
      }
      const pc = peerConnectionsRef.current[from];
      
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        if (pendingIceCandidatesRef.current[from]) {
          for (const candidate of pendingIceCandidatesRef.current[from]) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {}
          }
          delete pendingIceCandidatesRef.current[from];
        }
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { answer, to: from });
      } catch (error) {
        console.error("Error handling offer:", error);
      }
    }, 200);
  };

  const handleAnswer = async ({ answer, from }) => {
    const pc = peerConnectionsRef.current[from];
    if (pc && pc.signalingState === "have-local-offer") {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (error) {
        console.error("Error setting answer:", error);
      }
    }
  };

  const handleIceCandidate = async ({ candidate, from }) => {
    const pc = peerConnectionsRef.current[from];
    
    if (!pc) {
      if (!pendingIceCandidatesRef.current[from]) {
        pendingIceCandidatesRef.current[from] = [];
      }
      pendingIceCandidatesRef.current[from].push(candidate);
      return;
    }
    
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("Error adding ICE candidate:", error);
      }
    } else {
      if (!pendingIceCandidatesRef.current[from]) {
        pendingIceCandidatesRef.current[from] = [];
      }
      pendingIceCandidatesRef.current[from].push(candidate);
    }
  };

  const handleUserDisconnected = (userId) => {
    if (peerConnectionsRef.current[userId]) {
      peerConnectionsRef.current[userId].close();
      delete peerConnectionsRef.current[userId];
    }
    if (remoteVideosRef.current[userId]) {
      remoteVideosRef.current[userId].srcObject = null;
      delete remoteVideosRef.current[userId];
    }
    if (pendingIceCandidatesRef.current[userId]) {
      delete pendingIceCandidatesRef.current[userId];
    }
    setRemoteUsers(prev => prev.filter(id => id !== userId));
  };

  const createPeerConnection = async (userId, initiator) => {
    const pc = new RTCPeerConnection(servers);
    peerConnectionsRef.current[userId] = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.ontrack = (event) => {
      if (remoteVideosRef.current[userId]) {
        const videoElement = remoteVideosRef.current[userId];
        videoElement.srcObject = event.streams[0];
        // Play with error handling
        videoElement.play().catch(e => {
          console.log("Play prevented, user interaction needed");
        });
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", { candidate: event.candidate, to: userId });
      }
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { offer, to: userId });
      } catch (error) {
        console.error("Error creating offer:", error);
      }
    }

    return pc;
  };

  const startVideo = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      
      localStreamRef.current = stream;
      
      const attachStream = () => {
        if (localVideoRef.current && !localVideoRef.current.srcObject) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play().catch(e => console.log("Play on user interaction"));
        }
      };
      
      attachStream();
      setTimeout(attachStream, 100);
    } catch (error) {
      console.error("Error accessing camera:", error);
      alert("Please allow camera and microphone access");
    }
  };

  const joinRoom = async () => {
    if (!roomId || !userName) {
      alert("Enter Name and Room Code");
      return;
    }
    
    if (roomId.length !== 6) {
      alert("Room code must be 6 digits");
      return;
    }
    
    await startVideo();
    socket.emit("join-room", { roomId, userName });
    setJoined(true);
  };

  const createRoom = async () => {
    const id = generateRoomCode();
    setRoomId(id);
    const name = userName || "Anonymous";
    await startVideo();
    socket.emit("join-room", { roomId: id, userName: name });
    setJoined(true);
    alert(`Room created! Room Code: ${id}`);
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMicOn(audioTrack.enabled);
      }
    }
  };

  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setCameraOn(videoTrack.enabled);
      }
    }
  };

  const disconnectCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
    }
    Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
    socket.disconnect();
    window.location.reload();
  };

  return (
    <div style={{ background: "#111827", minHeight: "100vh", padding: "20px", paddingBottom: "80px", color: "white" }}>
      <h1 style={{ marginBottom: "20px" }}>Group Video Call</h1>
      
      {!joined ? (
        <div style={{ maxWidth: "400px", margin: "50px auto" }}>
          <input
            type="text"
            placeholder="Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            style={{ width: "100%", padding: "12px", margin: "10px 0", borderRadius: "8px", border: "1px solid #374151", background: "#1f2937", color: "white", outline: "none" }}
          />
          <input
            type="text"
            placeholder="6-Digit Room Code"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value.replace(/\D/g, '').slice(0, 6))}
            maxLength="6"
            style={{ width: "100%", padding: "12px", margin: "10px 0", borderRadius: "8px", border: "1px solid #374151", background: "#1f2937", color: "white", textAlign: "center", fontSize: "18px", letterSpacing: "4px", outline: "none" }}
          />
          <button onClick={joinRoom} style={{ width: "100%", padding: "12px", margin: "10px 0", background: "#2563eb", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", fontSize: "16px" }}>
            Join Meeting
          </button>
          <button onClick={createRoom} style={{ width: "100%", padding: "12px", margin: "10px 0", background: "#10b981", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: "bold", fontSize: "16px" }}>
            Create New Meeting
          </button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: "20px" }}>
            <div style={{ background: "#1f2937", padding: "12px 20px", borderRadius: "10px", display: "inline-block" }}>
              <span style={{ color: "#9ca3af" }}>Room Code: </span>
              <strong style={{ fontSize: "24px", letterSpacing: "4px", color: "#60a5fa" }}>{roomId}</strong>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: "20px" }}>
            {/* Local Video */}
            <div style={{ position: "relative", background: "#000", borderRadius: "12px", overflow: "hidden", aspectRatio: "16/9", border: cameraOn ? "2px solid #2563eb" : "2px solid #ef4444" }}>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <div style={{ position: "absolute", bottom: "12px", left: "12px", background: "rgba(0,0,0,0.7)", padding: "4px 12px", borderRadius: "20px", fontSize: "14px" }}>
                {userName || "Anonymous"} (You) {cameraOn ? "📷" : "🚫"}
              </div>
            </div>

            {/* Remote Videos */}
            {remoteUsers.map((userId, index) => (
              <div key={userId} style={{ position: "relative", background: "#000", borderRadius: "12px", overflow: "hidden", aspectRatio: "16/9" }}>
                <video
                  ref={ref => {
                    if (ref && !remoteVideosRef.current[userId]) {
                      remoteVideosRef.current[userId] = ref;
                    }
                  }}
                  autoPlay
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                <div style={{ position: "absolute", bottom: "12px", left: "12px", background: "rgba(0,0,0,0.7)", padding: "4px 12px", borderRadius: "20px", fontSize: "14px" }}>
                  Participant {index + 1}
                </div>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div style={{ position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)", background: "#1f2937", padding: "10px 24px", borderRadius: "50px", display: "flex", gap: "20px", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
            <button onClick={toggleMic} style={{ background: micOn ? "#10b981" : "#ef4444", border: "none", width: "48px", height: "48px", borderRadius: "50%", color: "white", cursor: "pointer", fontSize: "20px" }}>
              {micOn ? "🎤" : "🔇"}
            </button>
            <button onClick={toggleCamera} style={{ background: cameraOn ? "#2563eb" : "#ef4444", border: "none", width: "48px", height: "48px", borderRadius: "50%", color: "white", cursor: "pointer", fontSize: "20px" }}>
              {cameraOn ? "📷" : "🚫"}
            </button>
            <button onClick={disconnectCall} style={{ background: "#dc2626", border: "none", width: "48px", height: "48px", borderRadius: "50%", color: "white", cursor: "pointer", fontSize: "20px" }}>
              📞
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default VideoCall;