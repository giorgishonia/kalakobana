const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get available public rooms
app.get('/api/rooms', (req, res) => {
    const publicRooms = [];
    rooms.forEach((room, code) => {
        // Only show rooms in lobby phase with less than 8 players
        if (room.gameState.phase === 'lobby' && room.players.size < 8) {
            const host = Array.from(room.players.values()).find(p => p.isHost);
            publicRooms.push({
                code: room.code,
                hostName: host ? host.nick : 'Unknown',
                hostAvatar: host ? host.avatarSeed : 'Guest',
                playerCount: room.players.size,
                maxPlayers: 8,
                settings: {
                    rounds: room.settings.maxRounds,
                    hasBonus: room.settings.useBonus
                }
            });
        }
    });
    res.json(publicRooms);
});

// Georgian Alphabet
const GEORGIAN_ALPHABET = [
    'ა', 'ბ', 'გ', 'დ', 'ე', 'ვ', 'ზ', 'თ', 'ი', 'კ', 'ლ', 'მ', 'ნ', 'ო', 'პ',
    'ჟ', 'რ', 'ს', 'ტ', 'უ', 'ფ', 'ქ', 'ღ', 'ყ', 'შ', 'ჩ', 'ც', 'ძ', 'წ', 'ჭ', 'ხ', 'ჯ', 'ჰ'
];

const BONUS_CATEGORIES = ['ბრენდი', 'ფერი', 'ნივთი', 'მუსიკა', 'ფილმი', 'საჭმელი', 'სპორტი', 'პროფესია'];

const DEFAULT_CATEGORIES = ['ქალაქი', 'სოფელი', 'სახელი', 'გვარი', 'ცხოველი', 'ფრინველი', 'მცენარე'];

// Game state storage
const rooms = new Map();
const playerSessions = new Map(); // Maps sessionId -> { roomCode, playerId }
const disconnectedPlayers = new Map(); // Maps playerId -> { roomCode, timeout, playerData }

// Generate unique room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Generate unique player ID
function generatePlayerId() {
    return 'player_' + uuidv4().substring(0, 8);
}

// Create new room
function createRoom(hostId, hostData) {
    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        hostId: hostId,
        players: new Map(),
        settings: {
            minTime: 15,
            maxRounds: 5,
            useBonus: false,
            categories: [...DEFAULT_CATEGORIES]
        },
        gameState: {
            phase: 'lobby', // lobby, sticks, playing, stopped, results
            currentRound: 0,
            currentLetter: '',
            usedLetters: new Set(),
            activeCategories: {},
            roundStartTime: null,
            stoppedBy: null,
            timerEnabled: false,
            allAnswersSubmitted: false
        }
    };
    
    room.players.set(hostId, {
        id: hostId,
        nick: hostData.nick,
        avatarSeed: hostData.avatarSeed,
        isHost: true,
        isReady: true,
        isConnected: true,
        socketId: hostData.socketId,
        sessionId: hostData.sessionId,
        answers: {},
        roundScore: 0,
        totalScore: 0,
        hasSubmitted: false
    });
    
    rooms.set(roomCode, room);
    return room;
}

// Get room data for clients
function getRoomData(room) {
    const players = [];
    room.players.forEach((player, id) => {
        players.push({
            id: player.id,
            nick: player.nick,
            avatarSeed: player.avatarSeed,
            isHost: player.isHost,
            isReady: player.isReady,
            isConnected: player.isConnected,
            roundScore: player.roundScore,
            totalScore: player.totalScore
        });
    });
    
    return {
        code: room.code,
        hostId: room.hostId,
        players: players,
        settings: room.settings,
        gameState: {
            phase: room.gameState.phase,
            currentRound: room.gameState.currentRound,
            currentLetter: room.gameState.currentLetter,
            activeCategories: room.gameState.activeCategories,
            stoppedBy: room.gameState.stoppedBy,
            timerEnabled: room.gameState.timerEnabled
        }
    };
}

// Check if all players are ready
function allPlayersReady(room) {
    let allReady = true;
    room.players.forEach(player => {
        if (player.isConnected && !player.isReady) {
            allReady = false;
        }
    });
    return allReady && room.players.size >= 1;
}

// Select random letter
function selectRandomLetter(room) {
    const available = GEORGIAN_ALPHABET.filter(l => !room.gameState.usedLetters.has(l));
    if (available.length === 0) {
        room.gameState.usedLetters.clear();
        return GEORGIAN_ALPHABET[Math.floor(Math.random() * GEORGIAN_ALPHABET.length)];
    }
    return available[Math.floor(Math.random() * available.length)];
}

// Setup categories for round
function setupCategories(room) {
    const categories = {};
    
    // Use custom categories from room settings, or default if not set
    const categoryList = room.settings.categories || DEFAULT_CATEGORIES;
    
    // Convert array to object with keys
    categoryList.forEach((catName, index) => {
        categories[`cat_${index}`] = catName;
    });
    
    // Add random bonus category if enabled
    if (room.settings.useBonus) {
        const randomBonus = BONUS_CATEGORIES[Math.floor(Math.random() * BONUS_CATEGORIES.length)];
        categories['bonus'] = randomBonus;
    }
    
    room.gameState.activeCategories = categories;
    return categories;
}

// Calculate scores for all players
function calculateScores(room) {
    const players = Array.from(room.players.values());
    const categories = Object.keys(room.gameState.activeCategories);
    
    players.forEach(player => {
        player.roundScore = 0;
        player.categoryScores = {};
        
        categories.forEach(cat => {
            const answer = (player.answers[cat] || '').trim().toLowerCase();
            let points = 0;
            let isValid = false;
            
            if (answer.length > 0 && answer.startsWith(room.gameState.currentLetter.toLowerCase())) {
                isValid = true;
                points = 20; // Unique answer
                
                // Check for duplicates
                players.forEach(otherPlayer => {
                    if (otherPlayer.id !== player.id) {
                        const otherAnswer = (otherPlayer.answers[cat] || '').trim().toLowerCase();
                        if (otherAnswer === answer) {
                            points = 10; // Duplicate
                        }
                    }
                });
            }
            
            player.categoryScores[cat] = { points, isValid, answer: player.answers[cat] || '' };
            player.roundScore += points;
        });
        
        player.totalScore += player.roundScore;
    });
}

// Get all answers for results
function getAllAnswers(room) {
    const results = [];
    room.players.forEach(player => {
        results.push({
            id: player.id,
            nick: player.nick,
            avatarSeed: player.avatarSeed,
            isHost: player.isHost,
            answers: player.answers,
            categoryScores: player.categoryScores,
            roundScore: player.roundScore,
            totalScore: player.totalScore
        });
    });
    return results;
}

// Handle player disconnect with reconnection window
function handlePlayerDisconnect(socket, playerId, roomCode) {
    const room = rooms.get(roomCode);
    if (!room) {
        console.log(`Disconnect: Room ${roomCode} not found`);
        return;
    }
    
    const player = room.players.get(playerId);
    if (!player) {
        console.log(`Disconnect: Player ${playerId} not found in room`);
        return;
    }
    
    // Only mark as disconnected if this is the same socket
    if (player.socketId !== socket.id) {
        console.log(`Disconnect: Socket mismatch, ignoring. Player socket: ${player.socketId}, disconnecting socket: ${socket.id}`);
        return;
    }
    
    console.log(`Player ${player.nick} disconnecting from room ${roomCode}`);
    
    player.isConnected = false;
    player.socketId = null;
    
    // Clear any existing timeout for this player
    const existingDisconnect = disconnectedPlayers.get(playerId);
    if (existingDisconnect) {
        clearTimeout(existingDisconnect.timeout);
    }
    
    // Store player data for potential reconnection
    const timeout = setTimeout(() => {
        // After 2 minutes, remove player completely
        const currentRoom = rooms.get(roomCode);
        if (currentRoom) {
            const currentPlayer = currentRoom.players.get(playerId);
            if (currentPlayer && !currentPlayer.isConnected) {
                console.log(`Removing player ${currentPlayer.nick} after timeout`);
                currentRoom.players.delete(playerId);
                disconnectedPlayers.delete(playerId);
                
                // Clean up session
                if (currentPlayer.sessionId) {
                    playerSessions.delete(currentPlayer.sessionId);
                }
                
                // If host left, assign new host
                if (currentRoom.hostId === playerId && currentRoom.players.size > 0) {
                    const newHost = currentRoom.players.values().next().value;
                    newHost.isHost = true;
                    currentRoom.hostId = newHost.id;
                    io.to(roomCode).emit('host:changed', { newHostId: newHost.id });
                }
                
                // If room is empty, delete it
                if (currentRoom.players.size === 0) {
                    rooms.delete(roomCode);
                    console.log(`Room ${roomCode} deleted (empty after timeout)`);
                } else {
                    io.to(roomCode).emit('room:update', getRoomData(currentRoom));
                    io.to(roomCode).emit('player:left', { playerId, nick: player.nick });
                }
            }
        }
    }, 120000); // 2 minutes reconnection window
    
    disconnectedPlayers.set(playerId, {
        roomCode,
        timeout,
        playerData: player
    });
    
    // Notify other players
    io.to(roomCode).emit('player:disconnected', { playerId, nick: player.nick });
    io.to(roomCode).emit('room:update', getRoomData(room));
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    let currentPlayerId = null;
    let currentRoomCode = null;
    
    // Attempt to reconnect with session
    socket.on('session:restore', ({ sessionId, playerId }) => {
        console.log(`Session restore attempt: sessionId=${sessionId}, playerId=${playerId}`);
        
        // First, try to find the session
        let session = playerSessions.get(sessionId);
        let room = null;
        let player = null;
        
        // If session exists, try to get the room and player
        if (session) {
            room = rooms.get(session.roomCode);
            if (room) {
                player = room.players.get(playerId);
            }
        }
        
        // If no session found, try to find the player directly in any room
        // This handles cases where the session was lost but the player still exists
        if (!player) {
            for (const [roomCode, r] of rooms) {
                const p = r.players.get(playerId);
                if (p && p.sessionId === sessionId) {
                    room = r;
                    player = p;
                    session = { roomCode, playerId };
                    // Restore the session mapping
                    playerSessions.set(sessionId, session);
                    console.log('Found player in room without session, restoring:', roomCode);
                    break;
                }
            }
        }
        
        if (!room || !player) {
            console.log('Session restore failed - room or player not found');
            // Clean up stale session if it exists
            if (session) {
                playerSessions.delete(sessionId);
            }
            socket.emit('session:restored', { success: false });
            return;
        }
        
        // Clear any pending disconnect timeout
        const disconnected = disconnectedPlayers.get(playerId);
        if (disconnected) {
            clearTimeout(disconnected.timeout);
            disconnectedPlayers.delete(playerId);
            console.log('Cleared disconnect timeout for player');
        }
        
        // Check if there's an old socket that needs to be cleaned up
        if (player.socketId && player.socketId !== socket.id) {
            console.log(`Replacing old socket ${player.socketId} with new socket ${socket.id}`);
        }
        
        // Update player connection
        player.isConnected = true;
        player.socketId = socket.id;
        
        currentPlayerId = playerId;
        currentRoomCode = session.roomCode;
        
        socket.join(session.roomCode);
        
        // Send reconnection success
        socket.emit('session:restored', {
            success: true,
            playerId: playerId,
            roomCode: session.roomCode,
            roomData: getRoomData(room),
            playerData: {
                id: player.id,
                nick: player.nick,
                avatarSeed: player.avatarSeed,
                isHost: player.isHost
            }
        });
        
        // Notify others only if player was marked disconnected
        if (disconnected || !player.isConnected) {
            socket.to(session.roomCode).emit('player:reconnected', { 
                playerId, 
                nick: player.nick 
            });
        }
        io.to(session.roomCode).emit('room:update', getRoomData(room));
        
        console.log(`Player ${player.nick} reconnected to room ${session.roomCode} (phase: ${room.gameState.phase})`);
    });
    
    // Create room
    socket.on('room:create', ({ nick, avatarSeed, sessionId }) => {
        const playerId = generatePlayerId();
        const room = createRoom(playerId, {
            nick,
            avatarSeed,
            socketId: socket.id,
            sessionId
        });
        
        currentPlayerId = playerId;
        currentRoomCode = room.code;
        
        // Store session
        playerSessions.set(sessionId, { roomCode: room.code, playerId });
        
        socket.join(room.code);
        
        socket.emit('room:created', {
            roomCode: room.code,
            playerId: playerId,
            roomData: getRoomData(room)
        });
        
        console.log(`Room ${room.code} created by ${nick}`);
    });
    
    // Join room
    socket.on('room:join', ({ roomCode, nick, avatarSeed, sessionId }) => {
        const room = rooms.get(roomCode.toUpperCase());
        
        if (!room) {
            socket.emit('room:error', { message: 'ოთახი ვერ მოიძებნა' });
            return;
        }
        
        if (room.gameState.phase !== 'lobby') {
            socket.emit('room:error', { message: 'თამაში უკვე დაწყებულია' });
            return;
        }
        
        if (room.players.size >= 8) {
            socket.emit('room:error', { message: 'ოთახი სავსეა (მაქს. 8 მოთამაშე)' });
            return;
        }
        
        const playerId = generatePlayerId();
        
        room.players.set(playerId, {
            id: playerId,
            nick,
            avatarSeed,
            isHost: false,
            isReady: false,
            isConnected: true,
            socketId: socket.id,
            sessionId,
            answers: {},
            roundScore: 0,
            totalScore: 0,
            hasSubmitted: false
        });
        
        currentPlayerId = playerId;
        currentRoomCode = roomCode.toUpperCase();
        
        // Store session
        playerSessions.set(sessionId, { roomCode: room.code, playerId });
        
        socket.join(room.code);
        
        socket.emit('room:joined', {
            roomCode: room.code,
            playerId: playerId,
            roomData: getRoomData(room)
        });
        
        // Notify others
        socket.to(room.code).emit('player:joined', {
            id: playerId,
            nick,
            avatarSeed,
            isHost: false,
            isReady: false
        });
        
        io.to(room.code).emit('room:update', getRoomData(room));
        
        console.log(`${nick} joined room ${room.code}`);
    });
    
    // Toggle ready status
    socket.on('player:ready', ({ ready }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        
        const player = room.players.get(currentPlayerId);
        if (!player) return;
        
        player.isReady = ready;
        
        io.to(currentRoomCode).emit('room:update', getRoomData(room));
        io.to(currentRoomCode).emit('player:readyChanged', {
            playerId: currentPlayerId,
            ready
        });
    });
    
    // Update settings (host only)
    socket.on('settings:update', (settings) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        
        room.settings = { ...room.settings, ...settings };
        
        io.to(currentRoomCode).emit('room:update', getRoomData(room));
        io.to(currentRoomCode).emit('settings:changed', room.settings);
    });
    
    // Start game (host only)
    socket.on('game:start', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        
        if (!allPlayersReady(room)) {
            socket.emit('game:error', { message: 'ყველა მოთამაშე მზად არ არის' });
            return;
        }
        
        // Reset game state
        room.gameState.phase = 'sticks';
        room.gameState.currentRound = 0;
        room.gameState.usedLetters.clear();
        
        // Reset player scores
        room.players.forEach(player => {
            player.totalScore = 0;
            player.roundScore = 0;
            player.answers = {};
        });
        
        io.to(currentRoomCode).emit('game:started', getRoomData(room));
        io.to(currentRoomCode).emit('phase:sticks');
        
        console.log(`Game started in room ${currentRoomCode}`);
    });
    
    // Draw letter (host triggers)
    socket.on('sticks:draw', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        
        const letter = selectRandomLetter(room);
        room.gameState.currentLetter = letter;
        room.gameState.usedLetters.add(letter);
        
        io.to(currentRoomCode).emit('sticks:drawing', { duration: 2000 });
        
        setTimeout(() => {
            io.to(currentRoomCode).emit('sticks:result', { letter });
            
            // Start round after showing letter
            setTimeout(() => {
                startRound(room);
            }, 1500);
        }, 2000);
    });
    
    function startRound(room) {
        room.gameState.currentRound++;
        room.gameState.phase = 'playing';
        room.gameState.timerEnabled = false;
        room.gameState.stoppedBy = null;
        room.gameState.allAnswersSubmitted = false;
        
        // Reset player answers for new round
        room.players.forEach(player => {
            player.answers = {};
            player.hasSubmitted = false;
            player.roundScore = 0;
        });
        
        const categories = setupCategories(room);
        
        io.to(room.code).emit('round:start', {
            round: room.gameState.currentRound,
            maxRounds: room.settings.maxRounds,
            letter: room.gameState.currentLetter,
            categories: categories,
            minTime: room.settings.minTime
        });
        
        // Enable STOP button after minTime
        setTimeout(() => {
            room.gameState.timerEnabled = true;
            io.to(room.code).emit('stop:enabled');
        }, room.settings.minTime * 1000);
        
        console.log(`Round ${room.gameState.currentRound} started with letter ${room.gameState.currentLetter}`);
    }
    
    // Player typing indicator
    socket.on('player:typing', ({ category }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        socket.to(currentRoomCode).emit('player:isTyping', {
            playerId: currentPlayerId,
            category
        });
    });
    
    // Submit answers
    socket.on('answers:submit', ({ answers }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        
        const player = room.players.get(currentPlayerId);
        if (!player) return;
        
        player.answers = answers;
        player.hasSubmitted = true;
        
        io.to(currentRoomCode).emit('player:submitted', { playerId: currentPlayerId });
        
        // Check if all connected players have submitted
        let allSubmitted = true;
        room.players.forEach(p => {
            if (p.isConnected && !p.hasSubmitted) {
                allSubmitted = false;
            }
        });
        
        if (allSubmitted) {
            room.gameState.allAnswersSubmitted = true;
            io.to(currentRoomCode).emit('all:submitted');
        }
    });
    
    // Stop round
    socket.on('round:stop', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.gameState.phase !== 'playing') return;
        
        if (!room.gameState.timerEnabled) {
            socket.emit('game:error', { message: 'დაელოდეთ ტაიმერს' });
            return;
        }
        
        const player = room.players.get(currentPlayerId);
        room.gameState.phase = 'stopped';
        room.gameState.stoppedBy = player.nick;
        
        io.to(currentRoomCode).emit('round:stopped', { 
            stoppedBy: player.nick,
            countdown: 5
        });
        
        // Give 5 seconds for final answers
        setTimeout(() => {
            endRound(room);
        }, 5000);
        
        console.log(`Round stopped by ${player.nick}`);
    });
    
    function endRound(room) {
        room.gameState.phase = 'results';
        
        // Calculate scores
        calculateScores(room);
        
        const results = getAllAnswers(room);
        const isLastRound = room.gameState.currentRound >= room.settings.maxRounds;
        
        io.to(room.code).emit('round:results', {
            results,
            categories: room.gameState.activeCategories,
            currentLetter: room.gameState.currentLetter,
            round: room.gameState.currentRound,
            maxRounds: room.settings.maxRounds,
            isLastRound
        });
    }
    
    // Invalidate answer (during review)
    socket.on('answer:invalidate', ({ targetPlayerId, category }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        
        const targetPlayer = room.players.get(targetPlayerId);
        if (!targetPlayer) return;
        
        // Toggle validity
        if (targetPlayer.categoryScores && targetPlayer.categoryScores[category]) {
            const score = targetPlayer.categoryScores[category];
            if (score.invalidatedBy) {
                // Re-validate
                delete score.invalidatedBy;
                targetPlayer.roundScore += score.points;
                targetPlayer.totalScore += score.points;
            } else {
                // Invalidate
                score.invalidatedBy = currentPlayerId;
                targetPlayer.roundScore -= score.points;
                targetPlayer.totalScore -= score.points;
            }
            
            io.to(currentRoomCode).emit('answer:toggled', {
                targetPlayerId,
                category,
                categoryScores: targetPlayer.categoryScores,
                roundScore: targetPlayer.roundScore,
                totalScore: targetPlayer.totalScore
            });
        }
    });
    
    // Next round / End game
    socket.on('game:nextRound', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        
        if (room.gameState.currentRound >= room.settings.maxRounds) {
            // End game
            room.gameState.phase = 'ended';
            
            // Get final standings
            const standings = Array.from(room.players.values())
                .sort((a, b) => b.totalScore - a.totalScore)
                .map((p, idx) => ({
                    rank: idx + 1,
                    id: p.id,
                    nick: p.nick,
                    avatarSeed: p.avatarSeed,
                    totalScore: p.totalScore
                }));
            
            io.to(currentRoomCode).emit('game:ended', { standings });
            
            // Reset to lobby after delay
            setTimeout(() => {
                room.gameState.phase = 'lobby';
                room.gameState.currentRound = 0;
                room.gameState.usedLetters.clear();
                
                room.players.forEach(player => {
                    player.isReady = player.isHost;
                    player.totalScore = 0;
                    player.roundScore = 0;
                    player.answers = {};
                });
                
                io.to(currentRoomCode).emit('game:reset', getRoomData(room));
            }, 10000);
        } else {
            // Next round
            room.gameState.phase = 'sticks';
            io.to(currentRoomCode).emit('phase:sticks');
        }
    });
    
    // Return to lobby
    socket.on('game:returnToLobby', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        
        room.gameState.phase = 'lobby';
        room.gameState.currentRound = 0;
        room.gameState.usedLetters.clear();
        
        room.players.forEach(player => {
            player.isReady = player.isHost;
            player.totalScore = 0;
            player.roundScore = 0;
            player.answers = {};
        });
        
        io.to(currentRoomCode).emit('game:reset', getRoomData(room));
    });
    
    // Leave room
    socket.on('room:leave', () => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        
        const player = room.players.get(currentPlayerId);
        const playerNick = player ? player.nick : 'Unknown';
        
        // Remove from session
        if (player && player.sessionId) {
            playerSessions.delete(player.sessionId);
        }
        
        room.players.delete(currentPlayerId);
        socket.leave(currentRoomCode);
        
        // If host left, assign new host
        if (room.hostId === currentPlayerId && room.players.size > 0) {
            const newHost = room.players.values().next().value;
            newHost.isHost = true;
            room.hostId = newHost.id;
            io.to(currentRoomCode).emit('host:changed', { newHostId: newHost.id });
        }
        
        // If room is empty, delete it
        if (room.players.size === 0) {
            rooms.delete(currentRoomCode);
            console.log(`Room ${currentRoomCode} deleted (empty)`);
        } else {
            io.to(currentRoomCode).emit('room:update', getRoomData(room));
            io.to(currentRoomCode).emit('player:left', { 
                playerId: currentPlayerId, 
                nick: playerNick 
            });
        }
        
        socket.emit('room:left');
        
        currentPlayerId = null;
        currentRoomCode = null;
    });
    
    // Kick player (host only)
    socket.on('player:kick', ({ targetPlayerId }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room || room.hostId !== currentPlayerId) return;
        if (targetPlayerId === currentPlayerId) return; // Can't kick yourself
        
        const targetPlayer = room.players.get(targetPlayerId);
        if (!targetPlayer) return;
        
        // Remove session
        if (targetPlayer.sessionId) {
            playerSessions.delete(targetPlayer.sessionId);
        }
        
        // Notify kicked player
        if (targetPlayer.socketId) {
            io.to(targetPlayer.socketId).emit('player:kicked');
        }
        
        room.players.delete(targetPlayerId);
        
        io.to(currentRoomCode).emit('room:update', getRoomData(room));
        io.to(currentRoomCode).emit('player:left', { 
            playerId: targetPlayerId, 
            nick: targetPlayer.nick,
            kicked: true
        });
    });
    
    // Chat message
    socket.on('chat:message', ({ message }) => {
        if (!currentRoomCode || !currentPlayerId) return;
        
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        
        const player = room.players.get(currentPlayerId);
        if (!player) return;
        
        io.to(currentRoomCode).emit('chat:message', {
            playerId: currentPlayerId,
            nick: player.nick,
            avatarSeed: player.avatarSeed,
            message: message.substring(0, 200), // Limit message length
            timestamp: Date.now()
        });
    });
    
    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        if (currentRoomCode && currentPlayerId) {
            handlePlayerDisconnect(socket, currentPlayerId, currentRoomCode);
        }
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🎮 ქალაქობანა server running on http://localhost:${PORT}`);
});

