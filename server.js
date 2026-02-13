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
app.use(express.json({ limit: "10mb" }));

mongoose.connect(process.env.MONGO_URI);

// USER SCHEMA (DITAMBAH PROFILE PICTURE)
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  profilePicture: { type: String, default: "" }
});

const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  read: { type: Boolean, default: false },
  readAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

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

// LOGIN + KIRIM PP USER
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.json({ success: false });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false });

  res.json({
    success: true,
    profilePicture: user.profilePicture || ""
  });
});

// UPLOAD / UPDATE PROFILE PICTURE
app.post("/upload-pp", async (req, res) => {
  const { username, image } = req.body;
  if (!username || !image) {
    return res.json({ success: false });
  }

  await User.updateOne(
    { username },
    { profilePicture: image }
  );

  res.json({ success: true });
});

// GET USER PP
app.get("/user/:username", async (req, res) => {
  const user = await User.findOne(
    { username: req.params.username },
    "username profilePicture"
  );
  res.json(user);
});

// SEARCH USER + PP
app.get("/search/:username", async (req, res) => {
  const users = await User.find({
    username: { $regex: req.params.username, $options: "i" }
  }).select("username profilePicture");
  res.json(users);
});

// GET MESSAGES (DENGAN STATUS READ)
app.get("/messages/:user1/:user2", async (req, res) => {
  const msgs = await Message.find({
    $or: [
      { sender: req.params.user1, receiver: req.params.user2 },
      { sender: req.params.user2, receiver: req.params.user1 }
    ]
  }).sort({ createdAt: 1 });

  res.json(msgs);
});

// SOCKET REALTIME DM FIX
io.on("connection", (socket) => {

  // JOIN ROOM = USERNAME
  socket.on("join", (username) => {
    socket.join(username);
  });

  // SEND MESSAGE (DENGAN PP)
  socket.on("send_message", async (data) => {
    const { sender, receiver, message } = data;

    const senderUser = await User.findOne({ username: sender });

    const newMsg = new Message({
      sender,
      receiver,
      message
    });

    await newMsg.save();

    const payload = {
      _id: newMsg._id,
      sender,
      receiver,
      message,
      createdAt: newMsg.createdAt,
      senderPP: senderUser?.profilePicture || ""
    };

    // KIRIM KE PENERIMA SAJA (DM REAL)
    io.to(receiver).emit("receive_message", payload);
    io.to(sender).emit("receive_message", payload);
  });

  // READ MESSAGE + TIMESTAMP WIB SUPPORT
  socket.on("read_message", async (messageId) => {
    const msg = await Message.findByIdAndUpdate(
      messageId,
      {
        read: true,
        readAt: new Date()
      },
      { new: true }
    );

    if (!msg) return;

    io.to(msg.sender).emit("message_read", {
      _id: msg._id,
      readAt: msg.readAt
    });
  });
});

server.listen(5000, () => {
  console.log("Server running");
});
