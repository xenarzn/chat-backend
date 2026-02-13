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
// Limit besar untuk menangani transfer Foto Profil dan Voice Note (Base64)
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// Koneksi MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Database Terhubung"))
  .catch(err => console.error("Gagal Koneksi Database:", err));

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

// --- API ROUTES ---

// Registrasi & Login (Sederhana)
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hash });
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: "Username sudah ada" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.json({ success: false, message: "Kredensial salah" });
  }
  res.json({ success: true, profilePicture: user.profilePicture });
});

// Update Foto Profil
app.post("/update-pp", async (req, res) => {
  const { username, profilePicture } = req.body;
  await User.updateOne({ username }, { profilePicture });
  io.emit("pp_updated", { username, profilePicture });
  res.json({ success: true });
});

// Ambil Data User tunggal
app.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  res.json(user);
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

  // User Masuk
  socket.on("join", async (username) => {
    currentUsername = username;
    socket.join(username);
    
    // Set status jadi Online
    await User.updateOne({ username }, { lastSeen: new Date() });
    io.emit("user_status", { username, status: "online" });
  });

  // Kirim Pesan
  socket.on("send_message", async (data) => {
    const { sender, receiver, message, type } = data;
    const newMsg = new Message({ sender, receiver, message, type, read: false });
    await newMsg.save();

    const payload = { ...data, _id: newMsg._id, createdAt: newMsg.createdAt, read: false };
    
    // Kirim ke penerima dan pengirim
    io.to(receiver).emit("receive_message", payload);
    io.to(sender).emit("receive_message", payload);
  });

  // Logika Ceklis (Read Receipt)
  socket.on("read_message", async ({ messageId, sender }) => {
    try {
      await Message.findByIdAndUpdate(messageId, { read: true });
      // Beritahu si pengirim (sender) bahwa pesan tersebut sudah dibaca
      io.to(sender).emit("message_read", { messageId });
    } catch (err) {
      console.error("Gagal update status baca:", err);
    }
  });

  // Sedang Mengetik
  socket.on("typing", (data) => {
    // Teruskan status mengetik ke si penerima
    io.to(data.receiver).emit("display_typing", data);
  });

  // User Keluar / Diskonek
  socket.on("disconnect", async () => {
    if (currentUsername) {
      const now = new Date();
      await User.updateOne({ username: currentUsername }, { lastSeen: now });
      io.emit("user_status", { 
        username: currentUsername, 
        status: "offline", 
        lastSeen: now 
      });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
