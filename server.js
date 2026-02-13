const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "100mb" }));

mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model("User", new mongoose.Schema({
  username: { type: String, unique: true },
  password: { type: String },
  profilePicture: { type: String, default: "" },
  status: { type: String, default: "offline" }
}));

const Message = mongoose.model("Message", new mongoose.Schema({
  sender: String, receiver: String, type: String, message: String,
  read: { type: Boolean, default: false }, createdAt: { type: Date, default: Date.now }
}));

// API Routes
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await new User({ username, password: hash }).save();
    res.json({ success: true });
  } catch { res.json({ success: false }); }
});

app.post("/login", async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (user && await bcrypt.compare(req.body.password, user.password)) {
    res.json({ success: true, profilePicture: user.profilePicture });
  } else { res.json({ success: false }); }
});

app.post("/update-pp", async (req, res) => {
  await User.updateOne({ username: req.body.username }, { profilePicture: req.body.profilePicture });
  res.json({ success: true });
});

app.get("/user/:username", async (req, res) => {
  res.json(await User.findOne({ username: req.params.username }));
});

app.get("/messages/:u1/:u2", async (req, res) => {
  res.json(await Message.find({ $or: [{ sender: req.params.u1, receiver: req.params.u2 }, { sender: req.params.u2, receiver: req.params.u1 }] }).sort({ createdAt: 1 }));
});

// Socket Logic
io.on("connection", (socket) => {
  let uName = "";
  socket.on("join", async (username) => {
    uName = username; socket.join(username);
    await User.updateOne({ username }, { status: "online" });
    io.emit("user_status", { username, status: "online" });
  });

  socket.on("send_message", async (data) => {
    const msg = await new Message(data).save();
    io.to(data.receiver).emit("receive_message", msg);
    io.to(data.sender).emit("receive_message", msg);
  });

  socket.on("read_message", async ({ messageId, sender }) => {
    await Message.findByIdAndUpdate(messageId, { read: true });
    io.to(sender).emit("message_read", { messageId });
  });

  socket.on("edit_message", async ({ messageId, newMessage, receiver }) => {
    await Message.findByIdAndUpdate(messageId, { message: newMessage });
    io.to(uName).emit("message_edited", { messageId, newMessage });
    io.to(receiver).emit("message_edited", { messageId, newMessage });
  });

  socket.on("delete_message", async ({ messageId, receiver }) => {
    await Message.findByIdAndDelete(messageId);
    io.to(uName).emit("message_deleted", messageId);
    io.to(receiver).emit("message_deleted", messageId);
  });

  socket.on("typing", (data) => io.to(data.receiver).emit("display_typing", data));

  socket.on("disconnect", async () => {
    if (uName) {
      await User.updateOne({ username: uName }, { status: "offline" });
      io.emit("user_status", { username: uName, status: "offline" });
    }
  });
});

server.listen(process.env.PORT || 5000);
