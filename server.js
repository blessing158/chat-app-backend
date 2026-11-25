
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
const FieldValue = admin.firestore.FieldValue;

// Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Authentication middleware
async function authenticate(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "Authentication token required"
            });
        }

        req.user = await auth.verifyIdToken(
            header.substring(7)
        );

        next();
    } catch (error) {
        return res.status(401).json({
            error: "Invalid or expired authentication token"
        });
    }
}

// Check conversation membership
async function getConversation(conversationId, uid) {
    const ref = db.collection("conversations")
        .doc(conversationId);

    const snapshot = await ref.get();

    if (!snapshot.exists) {
        return null;
    }

    const conversation = snapshot.data();

    if (!Array.isArray(conversation.members) ||
        !conversation.members.includes(uid)) {
        return null;
    }

    return {
        ref: ref,
        data: conversation
    };
}

// Home
app.get("/", (req, res) => {
    res.json({
        name: "Chat App Backend",
        status: "running",
        version: "3.0.0"
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
        console.error("Health error:", error.message);

        res.status(503).json({
            status: "unhealthy",
            server: "online",
            database: "disconnected"
        });
    }
});

// Get profile
app.get("/api/me", authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection("users")
            .doc(req.user.uid)
            .get();

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

// Create or update profile
app.put("/api/me", authenticate, async (req, res) => {
    try {
        const displayName = String(
            req.body.displayName || ""
        ).trim();

        if (displayName.length < 2 ||
            displayName.length > 40) {
            return res.status(400).json({
                error: "Display name must be 2 to 40 characters"
            });
        }

        const profile = {
            uid: req.user.uid,
            email: req.user.email || null,
            displayName: displayName,
            updatedAt: FieldValue.serverTimestamp()
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

// Discover registered DevHub users
app.get("/api/users", authenticate, async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 30, 1),
            50
        );

        const pageToken = req.query.pageToken || undefined;

        const result = await auth.listUsers(limit, pageToken);

        const visibleUsers = result.users.filter(
            user => user.uid !== req.user.uid
        );

        const users = await Promise.all(
            visibleUsers.map(async user => {
                const profileSnapshot = await db.collection("users")
                    .doc(user.uid)
                    .get();

                const profile = profileSnapshot.exists
                    ? profileSnapshot.data()
                    : {};

                return {
                    uid: user.uid,
                    displayName: profile.displayName ||
                        user.displayName || "DevHub member"
                };
            })
        );

        res.json({
            users: users,
            nextPageToken: result.pageToken || null
        });

    } catch (error) {
        console.error("User discovery error:", error.message);

        res.status(500).json({
            error: "Could not load users"
        });
    }
});
            
// Create a private conversation
app.post("/api/conversations", authenticate, async (req, res) => {
    try {
        const otherUid = String(
            req.body.otherUid || ""
        ).trim();

        const myUid = req.user.uid;

        if (!otherUid || otherUid === myUid) {
            return res.status(400).json({
                error: "A valid other user ID is required"
            });
        }

        const otherUser = await auth.getUser(otherUid);

        const members = [myUid, otherUid].sort();

        const existing = await db.collection("conversations")
            .where("members", "==", members)
            .limit(1)
            .get();

        if (!existing.empty) {
            return res.json({
                message: "Conversation already exists",
                conversationId: existing.docs[0].id
            });
        }

        const conversation = await db.collection("conversations")
            .add({
                members: members,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
                lastMessage: null
            });

        res.status(201).json({
            message: "Conversation created",
            conversationId: conversation.id,
            otherUser: {
                uid: otherUser.uid,
                email: otherUser.email || null
            }
        });
    } catch (error) {
        console.error("Conversation error:", error.message);

        res.status(500).json({
            error: "Could not create conversation"
        });
    }
});

// List my conversations
app.get("/api/conversations", authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection("conversations")
            .where("members", "array-contains", req.user.uid)
            .orderBy("updatedAt", "desc")
            .limit(50)
            .get();

        const conversations = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({
            conversations: conversations
        });
    } catch (error) {
        console.error("Conversation list error:", error.message);

        res.status(500).json({
            error: "Could not load conversations"
        });
    }
});

// Send a message through REST
app.post(
    "/api/conversations/:conversationId/messages",
    authenticate,
    async (req, res) => {
        try {
            const conversationId = req.params.conversationId;

            const content = String(
                req.body.content || ""
            ).trim();

            if (!content || content.length > 5000) {
                return res.status(400).json({
                    error: "Message must contain 1 to 5000 characters"
                });
            }

            const conversation = await getConversation(
                conversationId,
                req.user.uid
            );

            if (!conversation) {
                return res.status(404).json({
                    error: "Conversation not found"
                });
            }

            const message = {
                conversationId: conversationId,
                senderId: req.user.uid,
                content: content,
                createdAt: FieldValue.serverTimestamp()
            };

            const messageRef = await conversation.ref
                .collection("messages")
                .add(message);

            await conversation.ref.update({
                lastMessage: content,
                updatedAt: FieldValue.serverTimestamp()
            });

            const responseMessage = {
                id: messageRef.id,
                conversationId: conversationId,
                senderId: req.user.uid,
                content: content
            };

            io.to("conversation:" + conversationId)
                .emit("new_message", responseMessage);

            res.status(201).json({
                message: "Message sent",
                data: responseMessage
            });
        } catch (error) {
            console.error("Send message error:", error.message);

            res.status(500).json({
                error: "Could not send message"
            });
        }
    }
);

// Load message history
app.get(
    "/api/conversations/:conversationId/messages",
    authenticate,
    async (req, res) => {
        try {
            const conversationId = req.params.conversationId;

            const conversation = await getConversation(
                conversationId,
                req.user.uid
            );

            if (!conversation) {
                return res.status(404).json({
                    error: "Conversation not found"
                });
            }

            const snapshot = await conversation.ref
                .collection("messages")
                .orderBy("createdAt", "desc")
                .limit(50)
                .get();

            const messages = snapshot.docs
                .map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }))
                .reverse();

            res.json({
                messages: messages
            });
        } catch (error) {
            console.error("Message history error:", error.message);

            res.status(500).json({
                error: "Could not load messages"
            });
        }
    }
);

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

// Real-time messaging
io.on("connection", (socket) => {
    console.log("User connected:", socket.user.uid);

    // Join a conversation
    socket.on("join_conversation", async (conversationId, callback) => {
        try {
            if (typeof conversationId !== "string" ||
                conversationId.length > 150) {
                throw new Error("Invalid conversation ID");
            }

            const conversation = await getConversation(
                conversationId,
                socket.user.uid
            );

            if (!conversation) {
                throw new Error("Conversation not found");
            }

            socket.join("conversation:" + conversationId);

            if (typeof callback === "function") {
                callback({
                    success: true,
                    conversationId: conversationId
                });
            }
        } catch (error) {
            if (typeof callback === "function") {
                callback({
                    success: false,
                    error: error.message
                });
            }
        }
    });

    // Send real-time message
    socket.on("send_message", async (data, callback) => {
        try {
            const conversationId = data &&
                data.conversationId;

            const content = String(
                data && data.content || ""
            ).trim();

            if (typeof conversationId !== "string" ||
                conversationId.length > 150) {
                throw new Error("Invalid conversation ID");
            }

            if (!content || content.length > 5000) {
                throw new Error("Invalid message content");
            }

            const conversation = await getConversation(
                conversationId,
                socket.user.uid
            );

            if (!conversation) {
                throw new Error("Conversation not found");
            }

            const message = {
                conversationId: conversationId,
                senderId: socket.user.uid,
                content: content,
                createdAt: FieldValue.serverTimestamp()
            };

            const messageRef = await conversation.ref
                .collection("messages")
                .add(message);

            await conversation.ref.update({
                lastMessage: content,
                updatedAt: FieldValue.serverTimestamp()
            });

            const responseMessage = {
                id: messageRef.id,
                conversationId: conversationId,
                senderId: socket.user.uid,
                content: content
            };

            io.to("conversation:" + conversationId)
                .emit("new_message", responseMessage);

            if (typeof callback === "function") {
                callback({
                    success: true,
                    message: responseMessage
                });
            }
        } catch (error) {
            if (typeof callback === "function") {
                callback({
                    success: false,
                    error: error.message
                });
            }
        }
    });

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

// Start server
const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("Chat backend version 3.0.0 running");
    console.log("Port:", PORT);
});
            
