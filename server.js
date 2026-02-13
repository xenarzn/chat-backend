const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 
});

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// Koneksi Database
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log("DB Error:", err));

// --- SCHEMAS ---

const User = mongoose.model("User", new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  profilePicture: { type: String, default: "" },
  status: { type: String, default: "offline" }
}));

const Message = mongoose.model("Message", new mongoose.Schema({
  sender: String,
  receiver: String,
  type: { type: String, default: "text" }, 
  message: String,
  replyTo: { 
    id: String,
    sender: String,
    text: String
  }, 
  read: { type: mongoose.Schema.Types.Mixed, default: false }, // Mendukung true, false, atau 'edited'
  createdAt: { type: Date, default: Date.now }
}));

// --- API ROUTES ---

app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await new User({ username, password: hash }).save();
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: "User sudah ada" }); }
});

app.post("/login", async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (user && await bcrypt.compare(req.body.password, user.password)) {
    res.json({ success: true, profilePicture: user.profilePicture });
  } else { res.json({ success: false, message: "Login Gagal" }); }
});

app.post("/update-pp", async (req, res) => {
  await User.updateOne({ username: req.body.username }, { profilePicture: req.body.profilePicture });
  res.json({ success: true });
});

app.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  res.json(user || {});
});

app.get("/messages/:u1/:u2", async (req, res) => {
  const msgs = await Message.find({ 
    $or: [
      { sender: req.params.u1, receiver: req.params.u2 }, 
      { sender: req.params.u2, receiver: req.params.u1 }
    ] 
  }).sort({ createdAt: 1 });
  res.json(msgs);
});

// --- SOCKET LOGIC ---

io.on("connection", (socket) => {
  let uName = "";

  socket.on("join", async (username) => {
    uName = username;
    socket.join(username);
    await User.updateOne({ username }, { status: "online" });
    io.emit("user_status", { username, status: "online" });
  });

  socket.on("send_message", async (data) => {
    try {
      const msg = new Message({
          sender: data.sender,
          receiver: data.receiver,
          message: data.message,
          type: data.type || "text",
          replyTo: data.replyTo ? {
              id: data.replyTo.id,
              sender: data.replyTo.sender,
              text: data.replyTo.text
          } : null
      });
      
      const savedMsg = await msg.save();
      
      io.to(data.receiver).emit("receive_message", savedMsg);
      io.to(data.sender).emit("receive_message", savedMsg);
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  socket.on("read_message", async ({ messageId, sender }) => {
    await Message.findByIdAndUpdate(messageId, { read: true });
    io.to(sender).emit("message_read", { messageId });
  });

  socket.on("edit_message", async ({ messageId, newMessage, receiver }) => {
    await Message.findByIdAndUpdate(messageId, { message: newMessage, read: 'edited' });
    io.to(uName).emit("message_edited", { messageId, newMessage });
    io.to(receiver).emit("message_edited", { messageId, newMessage });
  });

  socket.on("delete_message", async ({ messageId, receiver }) => {
    await Message.findByIdAndDelete(messageId);
    io.to(uName).emit("message_deleted", messageId);
    io.to(receiver).emit("message_deleted", messageId);
  });

  socket.on("typing", (data) => {
    io.to(data.receiver).emit("display_typing", data);
  });

  socket.on("disconnect", async () => {
    if (uName) {
      await User.updateOne({ username: uName }, { status: "offline" });
      io.emit("user_status", { username: uName, status: "offline" });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    
