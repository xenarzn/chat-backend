const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// CONNECT MONGODB (WAJIB ADA MONGO_URI DI RENDER ENV)
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log("Mongo Error:", err));

// USER SCHEMA
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
});

// MESSAGE SCHEMA (ditambah status & readAt untuk centang)
const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  status: { type: String, default: "sent" }, // sent | read
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

// REGISTER
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.json({ success: false, message: "Invalid input" });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hash });
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: "Username already used" });
  }
});

// LOGIN
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) return res.json({ success: false });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false });

  res.json({ success: true });
});

// SEARCH USERNAME
app.get("/search/:username", async (req, res) => {
  const users = await User.find({
    username: { $regex: req.params.username, $options: "i" }
  }).select("username");

  res.json(users);
});

// GET DM MESSAGES (HISTORY CHAT)
app.get("/messages/:user1/:user2", async (req, res) => {
  const msgs = await Message.find({
    $or: [
      { sender: req.params.user1, receiver: req.params.user2 },
      { sender: req.params.user2, receiver: req.params.user1 }
    ]
  }).sort({ createdAt: 1 });

  res.json(msgs);
});

// SOCKET.IO (FIX UTAMA AGAR DM TERKIRIM)
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // JOIN ROOM BERDASARKAN USERNAME (WAJIB)
  socket.on("join", (username) => {
    if (!username) return;
    socket.join(username);
    console.log("Joined room:", username);
  });

  // KIRIM PESAN DM
  socket.on("send_message", async (data) => {
    try {
      const { sender, receiver, message } = data;
      if (!sender || !receiver || !message) return;

      // Simpan ke database
      const newMessage = new Message({
        sender,
        receiver,
        message,
        status: "sent"
      });

      await newMessage.save();

      // Kirim ke penerima (PRIVATE DM)
      io.to(receiver).emit("receive_message", {
        _id: newMessage._id,
        sender,
        receiver,
        message,
        status: "sent",
        createdAt: newMessage.createdAt
      });

      // Kirim juga ke pengirim (agar bubble langsung muncul)
      io.to(sender).emit("receive_message", {
        _id: newMessage._id,
        sender,
        receiver,
        message,
        status: "sent",
        createdAt: newMessage.createdAt
      });

    } catch (err) {
      console.log("Send message error:", err);
    }
  });

  // READ RECEIPT (centang hijau + waktu GMT+7 nanti di frontend)
  socket.on("read_message", async (messageId) => {
    try {
      const msg = await Message.findByIdAndUpdate(
        messageId,
        { status: "read", readAt: new Date() },
        { new: true }
      );

      if (!msg) return;

      // Update ke pengirim bahwa pesan sudah dibaca
      io.to(msg.sender).emit("message_read", {
        _id: msg._id,
        status: "read",
        readAt: msg.readAt
      });

    } catch (err) {
      console.log("Read error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
