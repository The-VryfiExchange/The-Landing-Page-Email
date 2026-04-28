// Vercel Serverless Function
// Receives Getwaitlist webhook → forwards to Mailchimp
// Endpoint: https://your-project.vercel.app/api/getwaitlist-to-mailchimp

import crypto from 'crypto';

// Environment variables (set in Vercel dashboard - do NOT hardcode)
const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX; // e.g., "us12"
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const MAILCHIMP_TAG = process.env.MAILCHIMP_TAG || 'the-exchange-waitlist';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // Shared secret to verify requests

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: Verify the request is from your Getwaitlist webhook
  // Getwaitlist doesn't sign webhooks by default, so we use a secret query param
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    console.warn('Unauthorized webhook attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Parse the Getwaitlist payload
    const payload = req.body;

    // Validate it's a new signup event
    if (payload.event !== 'new_signup') {
      console.log(`Ignoring event type: ${payload.event}`);
      return res.status(200).json({ message: 'Event ignored' });
    }

    const signup = payload.signup;

    if (!signup || !signup.email) {
      console.error('Invalid payload - missing email', payload);
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Build the Mailchimp subscriber payload
    const subscriberHash = crypto
      .createHash('md5')
      .update(signup.email.toLowerCase())
      .digest('hex');

    const mailchimpData = {
      email_address: signup.email,
      status_if_new: 'subscribed', // 'subscribed' or 'pending' if you want double opt-in
      status: 'subscribed',
      merge_fields: {
        FNAME: signup.first_name || '',
        LNAME: signup.last_name || '',
        PRIORITY: signup.priority || 0,
        REFLINK: signup.referral_link || '',
        REFCOUNT: signup.amount_referred || 0,
        SOURCE: 'exchange-waitlist',
      },
      tags: [MAILCHIMP_TAG],
    };

    // Use PUT to /members/{hash} which creates OR updates the subscriber
    // (avoids 400 errors if they already exist in the audience)
    const mailchimpUrl = `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}`;

    const mailchimpResponse = await fetch(mailchimpUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64')}`,
      },
      body: JSON.stringify(mailchimpData),
    });

    const mailchimpResult = await mailchimpResponse.json();

    if (!mailchimpResponse.ok) {
      console.error('Mailchimp error:', mailchimpResult);
      return res.status(500).json({
        error: 'Mailchimp API error',
        details: mailchimpResult,
      });
    }

    // Tags need to be added via a separate API call (PUT /members doesn't accept tags)
    const tagsUrl = `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`;

    await fetch(tagsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64')}`,
      },
      body: JSON.stringify({
        tags: [{ name: MAILCHIMP_TAG, status: 'active' }],
      }),
    });

    console.log(`Successfully synced ${signup.email} to Mailchimp`);

    return res.status(200).json({
      success: true,
      email: signup.email,
      mailchimp_id: mailchimpResult.id,
    });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
