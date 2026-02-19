const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const rooms = new Map();

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generatePlayerId() {
    return Math.random().toString(36).substring(2, 12);
}

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';

    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.swf':
            contentType = 'application/x-shockwave-flash';
            break;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let playerId = null;
    let roomCode = null;

    console.log('新客户端连接');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('收到消息:', data.type);

            switch (data.type) {
                case 'join': {
                    playerId = generatePlayerId();
                    const playerName = data.playerName || '玩家';
                    
                    if (data.roomCode && rooms.has(data.roomCode)) {
                        roomCode = data.roomCode;
                        const room = rooms.get(roomCode);
                        
                        if (room.players.length >= 2) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: '房间已满'
                            }));
                            return;
                        }

                        const player = {
                            id: playerId,
                            name: playerName,
                            ws: ws,
                            isHost: false,
                            role: null,
                            allowedKeys: null
                        };
                        room.players.push(player);
                        room.swfUrl = data.swfUrl || room.swfUrl;

                        ws.send(JSON.stringify({
                            type: 'joined',
                            playerId: playerId,
                            roomCode: roomCode,
                            isHost: false,
                            role: null,
                            allowedKeys: null
                        }));

                        broadcastToRoom(roomCode, {
                            type: 'players',
                            players: room.players.map(p => ({
                                id: p.id,
                                name: p.name,
                                isHost: p.isHost,
                                role: p.role,
                                allowedKeys: p.allowedKeys
                            }))
                        }, playerId);

                        console.log(`玩家 ${playerName} 加入房间 ${roomCode}`);
                    } else {
                        roomCode = generateRoomCode();
                        const room = {
                            code: roomCode,
                            players: [{
                                id: playerId,
                                name: playerName,
                                ws: ws,
                                isHost: true,
                                role: 'p1',
                                allowedKeys: ['KeyA', 'KeyD', 'KeyW']
                            }],
                            swfUrl: data.swfUrl || null,
                            createdAt: Date.now()
                        };
                        rooms.set(roomCode, room);

                        ws.send(JSON.stringify({
                            type: 'joined',
                            playerId: playerId,
                            roomCode: roomCode,
                            isHost: true,
                            role: 'p1',
                            allowedKeys: ['KeyA', 'KeyD', 'KeyW']
                        }));

                        broadcastToRoom(roomCode, {
                            type: 'players',
                            players: room.players.map(p => ({
                                id: p.id,
                                name: p.name,
                                isHost: p.isHost,
                                role: p.role,
                                allowedKeys: p.allowedKeys
                            }))
                        }, playerId);

                        console.log(`创建新房间 ${roomCode}, 房主: ${playerName}`);
                    }
                    break;
                }
                
                case 'setRole': {
                    if (!roomCode || !rooms.has(roomCode)) return;
                    
                    const room = rooms.get(roomCode);
                    const hostPlayer = room.players.find(p => p.id === playerId);
                    
                    if (!hostPlayer || !hostPlayer.isHost) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: '只有房主可以分配角色'
                        }));
                        return;
                    }
                    
                    const targetPlayerId = data.targetPlayerId;
                    const newRole = data.role;
                    
                    const targetPlayer = room.players.find(p => p.id === targetPlayerId);
                    if (!targetPlayer) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: '玩家不存在'
                        }));
                        return;
                    }
                    
                    targetPlayer.role = newRole;
                    
                    if (newRole === 'p1') {
                        targetPlayer.allowedKeys = ['KeyA', 'KeyD', 'KeyW'];
                    } else if (newRole === 'p2') {
                        targetPlayer.allowedKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp'];
                    } else {
                        targetPlayer.allowedKeys = null;
                    }
                    
                    broadcastToRoom(roomCode, {
                        type: 'players',
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            isHost: p.isHost,
                            role: p.role,
                            allowedKeys: p.allowedKeys
                        }))
                    });
                    
                    console.log(`角色分配: ${targetPlayer.name} -> ${newRole}`);
                    break;
                }

                case 'key': {
                    if (!roomCode || !rooms.has(roomCode)) return;

                    broadcastToRoom(roomCode, {
                        type: 'key',
                        action: data.action,
                        down: data.down,
                        playerId: playerId
                    }, playerId);
                    break;
                }

                case 'leave': {
                    if (roomCode && rooms.has(roomCode)) {
                        const room = rooms.get(roomCode);
                        const playerIndex = room.players.findIndex(p => p.id === playerId);
                        
                        if (playerIndex !== -1) {
                            const leftPlayer = room.players[playerIndex];
                            room.players.splice(playerIndex, 1);
                            
                            if (room.players.length === 0) {
                                rooms.delete(roomCode);
                                console.log(`房间 ${roomCode} 已关闭 (无玩家)`);
                            } else {
                                if (leftPlayer.isHost) {
                                    room.players[0].isHost = true;
                                    room.players[0].ws.send(JSON.stringify({
                                        type: 'joined',
                                        playerId: room.players[0].id,
                                        roomCode: roomCode,
                                        isHost: true
                                    }));
                                }

                                broadcastToRoom(roomCode, {
                                    type: 'players',
                                    players: room.players.map(p => ({
                                        id: p.id,
                                        name: p.name,
                                        isHost: p.isHost
                                    }))
                                });
                            }
                        }
                    }
                    break;
                }

                case 'chat': {
                    if (!roomCode || !rooms.has(roomCode)) return;
                    const room = rooms.get(roomCode);
                    const player = room.players.find(p => p.id === playerId);
                    
                    if (player) {
                        broadcastToRoom(roomCode, {
                            type: 'chat',
                            playerName: player.name,
                            message: data.message
                        });
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('消息处理错误:', error);
        }
    });

    ws.on('close', () => {
        console.log('客户端断开连接:', playerId);
        
        if (roomCode && rooms.has(roomCode)) {
            const room = rooms.get(roomCode);
            const playerIndex = room.players.findIndex(p => p.id === playerId);
            
            if (playerIndex !== -1) {
                const leftPlayer = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    rooms.delete(roomCode);
                    console.log(`房间 ${roomCode} 已关闭 (无玩家)`);
                } else {
                    if (leftPlayer.isHost && room.players.length > 0) {
                        room.players[0].isHost = true;
                    }

                    broadcastToRoom(roomCode, {
                        type: 'players',
                        players: room.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            isHost: p.isHost
                        }))
                    });
                }
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
    });
});

function broadcastToRoom(roomCode, data, excludePlayerId) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    const message = JSON.stringify(data);
    
    room.players.forEach(player => {
        if (player.id !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    });
}

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`WebSocket服务运行在 ws://localhost:${PORT}`);
});
