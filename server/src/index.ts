import "dotenv/config";
import cors from "cors";
import express from "express";
import { sideChatsRouter } from "./routes/sideChats.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      try {
        const { protocol, hostname } = new URL(origin);
        if (protocol === "chrome-extension:" || (protocol === "http:" && hostname === "localhost")) {
          callback(null, true);
          return;
        }
      } catch {
        // fall through to reject
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
