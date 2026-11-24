
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const admin = require("firebase-admin");

const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// Firebase configuration
const requiredEnv = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY"
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        throw new Error("Missing environment variable: " + key);
    }
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY
                .replace(/\\n/g, "\n")
        })
    });
}

const db = admin.firestore();
const auth = admin.auth();

// Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Verify Firebase ID tokens
async function authenticate(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Authentication token required"
            });
        }

        const token = header.substring(7);
        req.user = await auth.verifyIdToken(token);
        next();

    } catch (error) {
        return res.status(401).json({
            error: "Invalid or expired authentication token"
        });
    }
}

// Home
app.get("/", (req, res) => {
    res.json({
        name: "Chat App Backend",
        status: "running",
        version: "2.0.0"
    });
});

// Health check
app.get("/api/health", async (req, res) => {
    try {
        await db.collection("_system")
            .doc("health")
            .get();

        res.json({
            status: "healthy",
            server: "online",
            database: "connected",
            authentication: "ready",
            messaging: "ready"
        });

    } catch (error) {
        console.error("Firestore health check failed:", error.message);

        res.status(503).json({
            status: "unhealthy",
            server: "online",
            database: "disconnected"
        });
    }
});

// Get the signed-in user's profile
app.get("/api/me", authenticate, async (req, res) => {
    try {
        const userRef = db.collection("users").doc(req.user.uid);
        const snapshot = await userRef.get();

        res.json({
            uid: req.user.uid,
            email: req.user.email || null,
            profile: snapshot.exists ? snapshot.data() : null
        });

    } catch (error) {
        console.error("Profile error:", error.message);
        res.status(500).json({
            error: "Could not load profile"
        });
    }
});

// Create or update the signed-in user's profile
app.put("/api/me", authenticate, async (req, res) => {
    try {
        const displayName = String(
            req.body.displayName || ""
        ).trim();

        if (displayName.length < 2 || displayName.length > 40) {
            return res.status(400).json({
                error: "Display name must be 2 to 40 characters"
            });
        }

        const profile = {
            uid: req.user.uid,
            email: req.user.email || null,
            displayName: displayName,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection("users")
            .doc(req.user.uid)
            .set(profile, { merge: true });

        res.json({
            message: "Profile saved",
            profile: {
                uid: profile.uid,
                email: profile.email,
                displayName: profile.displayName
            }
        });

    } catch (error) {
        console.error("Profile save error:", error.message);
        res.status(500).json({
            error: "Could not save profile"
        });
    }
});

// Authenticate Socket.IO connections
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth &&
            socket.handshake.auth.token;

        if (!token) {
            return next(new Error("Authentication required"));
        }

        socket.user = await auth.verifyIdToken(token);
        next();

    } catch (error) {
        next(new Error("Invalid authentication token"));
    }
});

io.on("connection", (socket) => {
    console.log("Authenticated user connected:", socket.user.uid);

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.user.uid);
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error("Server error:", err.message);
    res.status(500).json({
        error: "Internal server error"
    });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Chat backend is running");
    console.log("Port:", PORT);
});
