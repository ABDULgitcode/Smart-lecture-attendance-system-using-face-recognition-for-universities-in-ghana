import express from 'express';
import { app } from './app.js';
import { config } from './config.js';
import { connectDb } from './db.js';

export default app;
void express;

if (!process.env.VERCEL) {
  connectDb()
    .then(() => {
      app.listen(config.port, () => {
        console.log(`Attendance API listening on ${config.port}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
