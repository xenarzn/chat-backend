const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Konfigurasi Socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
// Penting: Limit ditingkatkan agar bisa menerima Foto & Audio dalam bentuk Base64
app.use(express.json({ limit: "100mb" })); 
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// Koneksi MongoDB (Pastikan variabel MONGO_URI sudah diatur di Environment Render)
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Terhubung ke MongoDB"))
  .catch(err => console.error("Gagal koneksi MongoDB:", err));

// --- SCHEMAS ---

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  profilePicture: { type: String, default: "" },
  lastSeen: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  type: { type: String, default: "text" }, // "text" atau "audio"
  message: String, 
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

// Helper untuk Avatar Default
function defaultAvatar(username) {
  return `https://ui-avatars.com/api/?name=${username}&background=2563eb&color=fff&size=128`;
}

// --- API ROUTES ---

// Registrasi
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hash });
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: "Username sudah digunakan" });
  }
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.json({ success: false, message: "User tidak ditemukan" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false, message: "Password salah" });

  res.json({
    success: true,
    profilePicture: user.profilePicture || defaultAvatar(username)
  });
});

// Update Foto Profil
app.post("/update-pp", async (req, res) => {
  try {
    const { username, profilePicture } = req.body;
    await User.updateOne({ username }, { profilePicture });
    
    // Broadcast perubahan foto secara realtime
    io.emit("pp_updated", { username, profilePicture });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// Ambil Data User (Termasuk Last Seen)
app.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.json(null);
  res.json({
    username: user.username,
    profilePicture: user.profilePicture || defaultAvatar(user.username),
    lastSeen: user.lastSeen
  });
});

// Ambil Riwayat Chat
app.get("/messages/:user1/:user2", async (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = await Message.find({
    $or: [
      { sender: user1, receiver: user2 },
      { sender: user2, receiver: user1 }
    ]
  }).sort({ createdAt: 1 });
  res.json(msgs);
});

// --- SOCKET.IO LOGIC ---

io.on("connection", (socket) => {
  let currentUsername = "";

  // User Join
  socket.on("join", async (username) => {
    currentUsername = username;
    socket.join(username);
    
    // Update status online
    await User.updateOne({ username }, { lastSeen: new Date() });
    io.emit("user_status", { username, status: "online" });
    console.log(`${username} joined`);
  });

  // Kirim Pesan
  socket.on("send_message", async (data) => {
    const { sender, receiver, message, type } = data;
    const newMsg = new Message({ sender, receiver, message, type });
    await newMsg.save();

    const payload = { ...data, createdAt: newMsg.createdAt, _id: newMsg._id };
    
    io.to(receiver).emit("receive_message", payload);
    io.to(sender).emit("receive_message", payload);
  });

  // Fitur Sedang Mengetik
  socket.on("typing", (data) => {
    // data: { sender, receiver, isTyping }
    io.to(data.receiver).emit("display_typing", data);
  });

  // User Disconnect
  socket.on("disconnect", async () => {
    if (currentUsername) {
      const now = new Date();
      await User.updateOne({ username: currentUsername }, { lastSeen: now });
      io.emit("user_status", { 
        username: currentUsername, 
        status: "offline", 
        lastSeen: now 
      });
      console.log(`${currentUsername} disconnected`);
    }
  });
});

// Port Dinamis untuk Render
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
