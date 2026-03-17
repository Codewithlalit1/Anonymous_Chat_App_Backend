require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('./models/User');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] } // Assuming Vite frontend
});

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Auth Routes
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashedPassword });
        await user.save();
        res.status(201).json({ message: 'User created' });
    } catch (error) {
        res.status(500).json({ error: 'Error registering user' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (error) {
        res.status(500).json({ error: 'Error logging in' });
    }
});

// Generate Room Route
app.get('/generate-room', (req, res) => {
    // In a more complex app, you'd verify the JWT token here first
    const roomId = uuidv4();
    res.json({ roomId });
});

// --- AI Summarization Route ---
app.post('/summarize-chat', async (req, res) => {
    try {
        const { messages } = req.body;
        
        if (!messages || messages.length === 0) {
            return res.status(400).json({ error: "No messages to summarize." });
        }

        // 1. Format the raw array of objects into a readable chat transcript
        const chatTranscript = messages.map(m => `${m.sender}: ${m.message}`).join('\n');
        
        // 2. Craft the prompt for Gemini
        const prompt = `You are a helpful AI assistant in a chat room. Summarize the following chat conversation into 3 concise bullet points. Focus on the main topics discussed:\n\n${chatTranscript}`;

        // 3. Initialize Gemini and generate the content
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        res.json({ summary: response.text() });
    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: "Failed to generate summary." });
    }
});

// Socket.IO Logic
// Socket.IO Logic
// --- NEW: In-memory storage for room states ---
const activeRooms = {}; 
// Looks like: { roomId: { owner: socket.id, waiting: [], participants: [] } }

// Socket.IO Logic
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // 1. The new "Knock" system
    // 1. The new "Knock" system
    // 1. The new "Knock" system
    socket.on('request-join', ({ roomId, username }) => {
        
        // --- NEW: Check if the room was permanently deleted ---
        if (activeRooms[roomId] && activeRooms[roomId].status === 'deleted') {
            socket.emit('room-deleted');
            return; // Stop them from going any further
        }

        // Scenario A: Room doesn't exist -> Create it and make them Owner
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = { 
                owner: socket.id, 
                waiting: [], 
                participants: [{ id: socket.id, username }],
                status: 'active' // Add an active status
            };
            socket.join(roomId);
            socket.emit('room-joined', { isOwner: true, participants: activeRooms[roomId].participants });
        } 
        // Scenario B: The Owner is double-knocking
        else if (activeRooms[roomId].owner === socket.id) {
            socket.join(roomId);
            socket.emit('room-joined', { isOwner: true, participants: activeRooms[roomId].participants });
        }
        // Scenario C: A normal guest is knocking
        else {
            const guest = { id: socket.id, username };
            const alreadyWaiting = activeRooms[roomId].waiting.find(u => u.id === socket.id);
            if (!alreadyWaiting) {
                activeRooms[roomId].waiting.push(guest);
            }
            
            socket.emit('waiting-for-approval');
            io.to(activeRooms[roomId].owner).emit('waiting-list-update', activeRooms[roomId].waiting);
            io.to(activeRooms[roomId].owner).emit('guest-knocked', guest.username);
        }
    });

    // --- NEW: Owner Deletes the Room ---
    socket.on('delete-room', ({ roomId }) => {
        const room = activeRooms[roomId];
        // Security check: Only the actual owner can trigger this
        if (room && room.owner === socket.id) {
            // Mark the room as dead
            room.status = 'deleted';
            
            // Tell everyone in the active chat that it's closing
            io.to(roomId).emit('room-deleted');
            
            // Tell everyone sitting in the waiting room that it's closing
            room.waiting.forEach(guest => {
                io.to(guest.id).emit('room-deleted');
            });

            // Forcefully eject all active sockets from the room
            io.in(roomId).socketsLeave(roomId);
            
            // Clear out the arrays to free up server memory
            room.participants = [];
            room.waiting = [];
        }
    });
    // 2. Owner Admits a User
    socket.on('admit-user', ({ roomId, guestId }) => {
        const room = activeRooms[roomId];
        if (room && room.owner === socket.id) {
            // Move guest from waiting array to participants array
            const guestIndex = room.waiting.findIndex(u => u.id === guestId);
            if (guestIndex !== -1) {
                const guest = room.waiting.splice(guestIndex, 1)[0];
                room.participants.push(guest);
                
                // Add the guest to the actual Socket.IO room
                const guestSocket = io.sockets.sockets.get(guestId);
                if (guestSocket) {
                    guestSocket.join(roomId);
                    guestSocket.emit('room-joined', { isOwner: false, participants: room.participants });
                }
                
                // Update everyone's participant lists
                io.to(roomId).emit('participants-update', room.participants);
                socket.emit('waiting-list-update', room.waiting);
            }
        }
    });

    // 3. Owner Denies a User
    socket.on('deny-user', ({ roomId, guestId }) => {
        const room = activeRooms[roomId];
        if (room && room.owner === socket.id) {
            room.waiting = room.waiting.filter(u => u.id !== guestId);
            io.to(guestId).emit('join-denied');
            socket.emit('waiting-list-update', room.waiting);
        }
    });

    // 4. Owner Kicks a User
    socket.on('kick-user', ({ roomId, guestId }) => {
        const room = activeRooms[roomId];
        if (room && room.owner === socket.id) {
            room.participants = room.participants.filter(u => u.id !== guestId);
            
            // Tell the user they were kicked and remove them from the socket room
            io.to(guestId).emit('kicked');
            const guestSocket = io.sockets.sockets.get(guestId);
            if (guestSocket) guestSocket.leave(roomId);
            
            // Update the room's participant list
            io.to(roomId).emit('participants-update', room.participants);
        }
    });

    // --- EXISTING MESSAGE LOGIC ---
    socket.on('send-message', ({ roomId, messageData }) => {
        socket.to(roomId).emit('receive-message', messageData);
    });

    socket.on('mark-read', ({ roomId, messageId }) => {
        socket.to(roomId).emit('message-read', messageId);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // In a production app, you'd want logic here to handle if the Owner disconnects!
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));