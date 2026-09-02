import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { sideChatsRouter } from "./routes/sideChats.js";

const here = path.dirname(fileURLToPath(import.meta.url));

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

const handleJsonParseError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  next(err);
};
app.use(handleJsonParseError);

app.get("/panel.css", (_req, res) => {
  res.sendFile(path.join(here, "../../extension/src/content/panel.css"));
});
app.use(express.static(path.join(here, "../public")));

const sideChatsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/side-chats", sideChatsLimiter, sideChatsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`SideChats server listening on http://localhost:${port}`);
});
