import "dotenv/config";
import cors from "cors";
import express from "express";
import { sideChatsRouter } from "./routes/sideChats.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("chrome-extension://") || origin.startsWith("http://localhost")) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
  }),
);
app.use(express.json());

app.use("/api/side-chats", sideChatsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`SideChats server listening on http://localhost:${port}`);
});
