
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const admin = require("firebase-admin");

const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// FIREBASE CONFIGURATION

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

// SOCKET.IO

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ONLINE CONNECTION TRACKING

const activeSockets = new Map();
const presenceWrites = new Map();

function addUserSocket(uid, socketId) {
    if (!activeSockets.has(uid)) {
        activeSockets.set(uid, new Set());
    }

    activeSockets.get(uid).add(socketId);
}

function removeUserSocket(uid, socketId) {
    const sockets = activeSockets.get(uid);

    if (!sockets) return false;

    sockets.delete(socketId);

    if (sockets.size === 0) {
        activeSockets.delete(uid);
        return true;
    }

    return false;
}

function isUserOnline(uid) {
    const sockets = activeSockets.get(uid);
    return !!sockets && sockets.size > 0;
}

function updatePresence(uid) {
    const previous = presenceWrites.get(uid) ||
        Promise.resolve();

    const next = previous.catch(function() {
    }).then(async function() {

        const online = isUserOnline(uid);

        const update = {
            isOnline: online
        };

        if (!online) {
            update.lastSeen = FieldValue.serverTimestamp();
        }

        await db.collection("users")
            .doc(uid)
            .set(update, { merge: true });

        return online;
    });

    presenceWrites.set(uid, next);

    return next;
}

function broadcastPresence(uid, online) {
    io.emit("presence_update", {
        uid: uid,
        isOnline: online,
        lastSeenMillis: online ? null : Date.now()
    });
}

// AUTHENTICATION

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

// CONVERSATION MEMBERSHIP

async function getConversation(conversationId, uid) {
    const ref = db.collection("conversations")
        .doc(conversationId);

    const snapshot = await ref.get();

    if (!snapshot.exists) return null;

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

// HELPERS

function getLastSeenMillis(profile) {
    if (!profile || !profile.lastSeen) return null;

    if (typeof profile.lastSeen.toMillis === "function") {
        return profile.lastSeen.toMillis();
    }

    return null;
}

// HOME

app.get("/", (req, res) => {
    res.json({
        name: "DevHub Backend",
        status: "running",
        version: "4.0.0"
    });
});

// HEALTH CHECK

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
            messaging: "ready",
            presence: "ready",
            typing: "ready"
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

// GET MY PROFILE

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

// CREATE OR UPDATE PROFILE

app.put("/api/me", authenticate, async (req, res) => {
    try {
        const displayName = String(
            req.body.displayName || ""
        ).trim();

        const username = String(
            req.body.username || ""
        ).trim().toLowerCase();

        const bio = String(
            req.body.bio || ""
        ).trim().slice(0, 160);

        const status = String(
            req.body.status || ""
        ).trim().slice(0, 60);

        if (displayName.length < 2 ||
            displayName.length > 40) {
            return res.status(400).json({
                error: "Display name must be 2 to 40 characters"
            });
        }

        if (!/^[a-z0-9_]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: "Username must be 3-20 characters using letters, numbers or underscores"
            });
        }

        const userRef = db.collection("users")
            .doc(req.user.uid);

        const usernameRef = db.collection("usernames")
            .doc(username);

        await db.runTransaction(async transaction => {

            const userSnapshot =
                await transaction.get(userRef);

            const usernameSnapshot =
                await transaction.get(usernameRef);

            if (usernameSnapshot.exists &&
                usernameSnapshot.data().uid !== req.user.uid) {

                const error = new Error(
                    "That username is already taken"
                );

                error.code = "USERNAME_TAKEN";
                throw error;
            }

            const oldProfile = userSnapshot.exists
                ? userSnapshot.data()
                : {};

            if (oldProfile.username &&
                oldProfile.username !== username) {

                const oldRef = db.collection("usernames")
                    .doc(oldProfile.username);

                const oldSnapshot =
                    await transaction.get(oldRef);

                if (oldSnapshot.exists &&
                    oldSnapshot.data().uid === req.user.uid) {
                    transaction.delete(oldRef);
                }
            }

            transaction.set(usernameRef, {
                uid: req.user.uid,
                username: username
            });

            transaction.set(userRef, {
                uid: req.user.uid,
                email: req.user.email || null,
                displayName: displayName,
                username: username,
                bio: bio,
                status: status,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
        });

        res.json({
            message: "Profile saved successfully",
            profile: {
                uid: req.user.uid,
                displayName: displayName,
                username: username,
                bio: bio,
                status: status
            }
        });

    } catch (error) {

        if (error.code === "USERNAME_TAKEN") {
            return res.status(409).json({
                error: "That username is already taken"
            });
        }

        console.error("Profile save error:", error.message);

        res.status(500).json({
            error: "Could not save profile"
        });
    }
});

// DISCOVER REGISTERED USERS

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
                        user.displayName || "DevHub member",
                    username: profile.username || null,
                    isOnline: !!profile.isOnline,
                    lastSeenMillis: getLastSeenMillis(profile)
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

// GET ONE USER'S PRESENCE

app.get("/api/users/:uid/presence", authenticate, async (req, res) => {
    try {
        const uid = String(req.params.uid || "");

        if (!uid || uid.length > 128) {
            return res.status(400).json({
                error: "Invalid user ID"
            });
        }

        const snapshot = await db.collection("users")
            .doc(uid)
            .get();

        const profile = snapshot.exists
            ? snapshot.data()
            : {};

        res.json({
            uid: uid,
            isOnline: !!profile.isOnline,
            lastSeenMillis: getLastSeenMillis(profile)
        });

    } catch (error) {
        console.error("Presence lookup error:", error.message);

        res.status(500).json({
            error: "Could not load user presence"
        });
    }
});

// CREATE PRIVATE CONVERSATION

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

// LIST MY CONVERSATIONS

app.get("/api/conversations", authenticate, async (req, res) => {
    try {
        const snapshot = await db.collection("conversations")
            .where("members", "array-contains", req.user.uid)
            .get();

        const conversations = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        conversations.sort((a, b) => {
            const timeA = a.updatedAt &&
                a.updatedAt.toMillis
                ? a.updatedAt.toMillis()
                : 0;

            const timeB = b.updatedAt &&
                b.updatedAt.toMillis
                ? b.updatedAt.toMillis()
                : 0;

            return timeB - timeA;
        });

        res.json({
            conversations: conversations.slice(0, 50)
        });

    } catch (error) {
        console.error("Conversation list error:", error.message);

        res.status(500).json({
            error: "Could not load conversations",
            details: error.message
        });
    }
});


// SEND MESSAGE THROUGH REST

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

// LOAD MESSAGE HISTORY

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

// SOCKET AUTHENTICATION

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

// SOCKET CONNECTION

io.on("connection", async (socket) => {

    const uid = socket.user.uid;

    console.log("User connected:", uid);

    addUserSocket(uid, socket.id);

    socket.data.joinedConversations = new Set();

    try {
        const online = await updatePresence(uid);
        broadcastPresence(uid, online);
    } catch (error) {
        console.error("Online status error:", error.message);
    }

    // JOIN PRIVATE CONVERSATION

    socket.on("join_conversation", async (conversationId, callback) => {
        try {
            if (typeof conversationId !== "string" ||
                conversationId.length > 150) {
                throw new Error("Invalid conversation ID");
            }

            const conversation = await getConversation(
                conversationId,
                uid
            );

            if (!conversation) {
                throw new Error("Conversation not found");
            }

            const room = "conversation:" + conversationId;

            socket.join(room);

            socket.data.joinedConversations.add(conversationId);

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

    // REAL-TIME MESSAGE

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
                uid
            );

            if (!conversation) {
                throw new Error("Conversation not found");
            }

            const message = {
                conversationId: conversationId,
                senderId: uid,
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
                senderId: uid,
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

    // TYPING INDICATOR

    socket.on("typing", async (data) => {
        try {
            const conversationId = data &&
                data.conversationId;

            const isTyping = !!(data && data.isTyping);

            if (typeof conversationId !== "string" ||
                conversationId.length > 150) {
                return;
            }

            if (!socket.data.joinedConversations ||
                !socket.data.joinedConversations.has(conversationId)) {
                return;
            }

            socket.to("conversation:" + conversationId)
                .emit("user_typing", {
                    conversationId: conversationId,
                    uid: uid,
                    isTyping: isTyping
                });

        } catch (error) {
            console.error("Typing event error:", error.message);
        }
    });

    // PRESENCE HEARTBEAT

    socket.on("presence_heartbeat", function() {
        socket.emit("presence_heartbeat_ack", {
            success: true
        });
    });

    // DISCONNECT

    socket.on("disconnect", async () => {

        console.log("User disconnected:", uid);

        const lastConnection = removeUserSocket(
            uid,
            socket.id
        );

        if (lastConnection) {
            try {
                const online = await updatePresence(uid);

                broadcastPresence(uid, online);

            } catch (error) {
                console.error(
                    "Offline status error:",
                    error.message
                );
            }
        }
    });
});

// ERROR HANDLER

app.use((err, req, res, next) => {
    console.error("Server error:", err.message);

    res.status(500).json({
        error: "Internal server error"
    });
});

// START SERVER

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
    console.log("DevHub backend version 4.0.0 running");
    console.log("Port:", PORT);
});
    
