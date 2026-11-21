# Push notifications

The default provider is Expo (`PUSH_PROVIDER=expo`). The Expo Server SDK sends one notification to
each active device token after the second approval of a route batch. Its data includes the first
dispatch ID from the immutable approval event, the zone, and an aggregate priority (`urgent` if any
dispatch in the batch is urgent, otherwise `normal`); the body reports the confirmed batch count.
Set `EXPO_ACCESS_TOKEN` when push security is enabled for the Expo project. Expo delivery receipts
are polled every 15 minutes; pending receipt IDs are held in process memory and can be lost if the
server restarts before polling.

Firebase Admin is available as an alternative with `PUSH_PROVIDER=firebase` and the
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` settings. Firebase expects
an installation ID, so the mobile token registration must match the selected provider.
