
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(helmet());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        name: "Chat App Backend",
        status: "running",
        version: "1.0.0"
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "healthy",
        server: "online",
        database: "not_connected",
        messaging: "initializing"
    });
});

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Chat backend is running");
    console.log("Port:", PORT);
});
