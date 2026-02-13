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
// Limit ditingkatkan ke 100mb untuk menangani upload gambar & audio base64
app.use(express.json({ limit: "100mb" })); 
app.use(express.urlencoded({ limit: "100mb", extended: true }));

mongoose.connect(process.env.MONGO_URI);

// USER SCHEMA
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  profilePicture: { type: String, default: "" }
});

// MESSAGE SCHEMA
const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  type: { type: String, default: "text" }, 
  message: String, 
  read: { type: Boolean, default: false },
  readAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

// DEFAULT AVATAR
function defaultAvatar(username){
  return `https://ui-avatars.com/api/?name=${username}&background=2563eb&color=fff&size=128`;
}

// REGISTER
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hash });
    await user.save();
    res.json({ success: true });
  } catch {
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

  res.json({
    success: true,
    profilePicture: user.profilePicture || defaultAvatar(username)
  });
});

// --- UPDATE/UPLOAD PP (Sinkron dengan UI) ---
app.post("/update-pp", async (req, res) => {
  try {
    const { username, profilePicture } = req.body; // Menggunakan nama sesuai UI
    if (!username || !profilePicture) {
      return res.status(400).json({ success: false, message: "Data tidak lengkap" });
    }

    await User.updateOne(
      { username },
      { profilePicture: profilePicture }
    );

    // Kirim sinyal ke semua orang bahwa user ini ganti foto
    io.emit("pp_updated", {
      username,
      profilePicture: profilePicture
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET USER
app.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.json(null);
  res.json({
    username: user.username,
    profilePicture: user.profilePicture || defaultAvatar(user.username)
  });
});

// GET HISTORY
app.get("/messages/:user1/:user2", async (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = await Message.find({
    $or: [
      { sender: user1, receiver: user2 },
      { sender: user2, receiver: user1 }
    ]
  }).sort({ createdAt: 1 });

  const usernames = [...new Set(msgs.flatMap(m => [m.sender, m.receiver]))];
  const users = await User.find({ username: { $in: usernames } });

  const userMap = {};
  users.forEach(u => {
    userMap[u.username] = u.profilePicture || defaultAvatar(u.username);
  });

  const messagesWithPP = msgs.map(m => ({
    _id: m._id,
    sender: m.sender,
    receiver: m.receiver,
    type: m.type,
    message: m.message,
    read: m.read,
    readAt: m.readAt,
    createdAt: m.createdAt,
    senderPP: userMap[m.sender]
  }));

  res.json(messagesWithPP);
});

// SOCKET REALTIME
io.on("connection", (socket) => {
  socket.on("join", (username) => {
    socket.join(username);
  });

  socket.on("send_message", async (data) => {
    const { sender, receiver, message, type } = data;
    if (!sender || !receiver || !message) return;

    const senderUser = await User.findOne({ username: sender });
    const newMsg = new Message({
      sender,
      receiver,
      message,
      type: type || "text"
    });

    await newMsg.save();

    const payload = {
      _id: newMsg._id,
      sender,
      receiver,
      message,
      type: newMsg.type,
      createdAt: newMsg.createdAt,
      read: false,
      senderPP: senderUser?.profilePicture || defaultAvatar(sender)
    };

    io.to(receiver).emit("receive_message", payload);
    io.to(sender).emit("receive_message", payload);
  });

  socket.on("read_message", async (messageId) => {
    const msg = await Message.findByIdAndUpdate(messageId, { read: true, readAt: new Date() }, { new: true });
    if (msg) {
      io.to(msg.sender).emit("message_read", { _id: msg._id, readAt: msg.readAt });
    }
  });
});

// Gunakan port dari environment (Render) atau 5000
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
