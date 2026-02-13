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
app.use(express.json({ limit: "100mb" })); // dinaikkan untuk audio base64

mongoose.connect(process.env.MONGO_URI);

// USER SCHEMA
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  profilePicture: { type: String, default: "" }
});

// MESSAGE SCHEMA (SUPPORT TEXT + AUDIO/VN)
const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  type: { type: String, default: "text" }, // text | audio
  message: String, // text atau base64 audio
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

// LOGIN + PP
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

// UPLOAD PP (SYNC GLOBAL)
app.post("/upload-pp", async (req, res) => {
  const { username, image } = req.body;
  if (!username || !image) {
    return res.json({ success: false });
  }

  await User.updateOne(
    { username },
    { profilePicture: image }
  );

  io.emit("pp_updated", {
    username,
    profilePicture: image
  });

  res.json({ success: true });
});

// GET USER + PP
app.get("/user/:username", async (req, res) => {
  const user = await User.findOne(
    { username: req.params.username },
    "username profilePicture"
  );

  if (!user) return res.json(null);

  res.json({
    username: user.username,
    profilePicture: user.profilePicture || defaultAvatar(user.username)
  });
});

// SEARCH USER + PP
app.get("/search/:username", async (req, res) => {
  const users = await User.find({
    username: { $regex: req.params.username, $options: "i" }
  }).select("username profilePicture");

  const result = users.map(u => ({
    username: u.username,
    profilePicture: u.profilePicture || defaultAvatar(u.username)
  }));

  res.json(result);
});

// GET HISTORY (TEXT + VN + PP)
app.get("/messages/:user1/:user2", async (req, res) => {
  const { user1, user2 } = req.params;

  const msgs = await Message.find({
    $or: [
      { sender: user1, receiver: user2 },
      { sender: user2, receiver: user1 }
    ]
  }).sort({ createdAt: 1 });

  const usernames = [
    ...new Set(
      msgs.flatMap(m => [m.sender, m.receiver])
    )
  ];

  const users = await User.find({
    username: { $in: usernames }
  }).select("username profilePicture");

  const userMap = {};
  users.forEach(u => {
    userMap[u.username] =
      u.profilePicture && u.profilePicture !== ""
        ? u.profilePicture
        : defaultAvatar(u.username);
  });

  const messagesWithPP = msgs.map(m => ({
    _id: m._id,
    sender: m.sender,
    receiver: m.receiver,
    type: m.type || "text",
    message: m.message,
    read: m.read,
    readAt: m.readAt,
    createdAt: m.createdAt,
    senderPP: userMap[m.sender] || defaultAvatar(m.sender)
  }));

  res.json(messagesWithPP);
});

// SOCKET REALTIME
io.on("connection", (socket) => {

  socket.on("join", (username) => {
    socket.join(username);
  });

  // SEND TEXT ATAU VOICE NOTE
  socket.on("send_message", async (data) => {
    const { sender, receiver, message, type } = data;

    if (!sender || !receiver || !message) return;

    const senderUser = await User.findOne({ username: sender });

    const newMsg = new Message({
      sender,
      receiver,
      message,
      type: type || "text" // "text" atau "audio"
    });

    await newMsg.save();

    const senderPP =
      senderUser?.profilePicture && senderUser.profilePicture !== ""
        ? senderUser.profilePicture
        : defaultAvatar(sender);

    const payload = {
      _id: newMsg._id,
      sender,
      receiver,
      message,
      type: newMsg.type,
      createdAt: newMsg.createdAt,
      read: false,
      senderPP: senderPP
    };

    // KIRIM DM REALTIME
    io.to(receiver).emit("receive_message", payload);
    io.to(sender).emit("receive_message", payload);
  });

  // READ MESSAGE
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
  console.log("Server running with VN + PP + History + Realtime");
});
