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

mongoose.connect(process.env.MONGO_URI);

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String
});

const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

// Register
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

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.json({ success: false });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false });

  res.json({ success: true });
});

// Search username
app.get("/search/:username", async (req, res) => {
  const users = await User.find({
    username: { $regex: req.params.username, $options: "i" }
  }).select("username");
  res.json(users);
});

// Get DM messages
app.get("/messages/:user1/:user2", async (req, res) => {
  const msgs = await Message.find({
    $or: [
      { sender: req.params.user1, receiver: req.params.user2 },
      { sender: req.params.user2, receiver: req.params.user1 }
    ]
  }).sort({ createdAt: 1 });
  res.json(msgs);
});

io.on("connection", (socket) => {
  socket.on("send_message", async (data) => {
    const msg = new Message(data);
    await msg.save();
    io.emit("receive_message", data);
  });
});

server.listen(5000, () => {
  console.log("Server running");
});
