const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: "100mb" })); 
app.use(express.urlencoded({ limit: "100mb", extended: true }));

mongoose.connect(process.env.MONGO_URI);

// SCHEMAS
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  profilePicture: { type: String, default: "" },
  lastSeen: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  type: { type: String, default: "text" }, 
  message: String, 
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

const defaultAvatar = (u) => `https://ui-avatars.com/api/?name=${u}&background=2563eb&color=fff`;

// ROUTES
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hash });
    await user.save();
    res.json({ success: true });
  } catch { res.json({ success: false }); }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.json({ success: false });
  res.json({ success: true, profilePicture: user.profilePicture || defaultAvatar(username) });
});

app.post("/update-pp", async (req, res) => {
  const { username, profilePicture } = req.body;
  await User.updateOne({ username }, { profilePicture });
  io.emit("pp_updated", { username, profilePicture });
  res.json({ success: true });
});

app.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.json(null);
  res.json({ username: user.username, profilePicture: user.profilePicture || defaultAvatar(user.username), lastSeen: user.lastSeen });
});

app.get("/messages/:user1/:user2", async (req, res) => {
  const msgs = await Message.find({
    $or: [{ sender: req.params.user1, receiver: req.params.user2 }, { sender: req.params.user2, receiver: req.params.user1 }]
  }).sort({ createdAt: 1 });
  res.json(msgs);
});

// SOCKET LOGIC
io.on("connection", (socket) => {
  let currentSocketUser = "";

  socket.on("join", async (username) => {
    currentSocketUser = username;
    socket.join(username);
    await User.updateOne({ username }, { lastSeen: new Date() });
    io.emit("user_status", { username, status: "online" });
  });

  socket.on("send_message", async (data) => {
    const newMsg = new Message(data);
    await newMsg.save();
    io.to(data.receiver).emit("receive_message", { ...data, createdAt: newMsg.createdAt });
    io.to(data.sender).emit("receive_message", { ...data, createdAt: newMsg.createdAt });
  });

  socket.on("typing", (data) => {
    io.to(data.receiver).emit("display_typing", data);
  });

  socket.on("disconnect", async () => {
    if (currentSocketUser) {
      const now = new Date();
      await User.updateOne({ username: currentSocketUser }, { lastSeen: now });
      io.emit("user_status", { username: currentSocketUser, status: "offline", lastSeen: now });
    }
  });
});

server.listen(process.env.PORT || 5000);
