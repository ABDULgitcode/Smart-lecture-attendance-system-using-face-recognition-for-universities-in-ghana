import { Notification } from '../models.js';

export async function notifyMany(items) {
  if (!items?.length) return;
  try {
    await Notification.insertMany(items, { ordered: false });
  } catch (error) {
    console.error('Notification save failed', error.message);
  }
}

export function notify(userId, type, message) {
  return notifyMany([{ userId, type, message }]);
}
