# server.py (스마트 확성기 버전)
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"🔌 [접속] 현재 접속자 수: {len(self.active_connections)}명")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"👋 [해제] 남은 접속자 수: {len(self.active_connections)}명")

    async def broadcast(self, message: dict):
        # [중요] 리스트를 복사([:])하여 순회해야 루프 중 삭제 시 에러가 안 남
        for connection in self.active_connections[:]:
            try:
                await connection.send_json(message)
            except Exception as e:
                # 전송 실패 시 죽은 연결로 간주하고 명단에서 삭제 (Garbage Collection)
                print(f"🧹 죽은 연결 청소 중... ({e})")
                self.disconnect(connection)

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text() # 연결 유지용 (Ping/Pong)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)

@app.post("/api/log")
async def receive_log(data: dict):
    # 로그 출력 (필요한 정보만 깔끔하게)
    if data.get('type') == 'LIKE':
        print(f"👍 좋아요 수신: {data.get('count')}")
    else:
        print(f"📨 데이터 수신: {data}")
    
    # 리액트로 전송
    await manager.broadcast(data)
    return {"status": "ok"}

if __name__ == "__main__":
    print("🚀 중계 서버 가동 (Auto-Clean 모드): http://localhost:5002")
    uvicorn.run(app, host="0.0.0.0", port=5002)