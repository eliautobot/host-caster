// Phrase banks for the scripted fallback. {placeholders} are filled from the context packet only, so every fact
// the scripted fallback says is true. Kept separate from the composer so it’s easy to grow and translate.

export const OUTRO = [
  'That was {song} by {artist}.',
  '{artist} there, with {song}.',
  'You just heard {song}, from {artist}.',
  'There it is. {song}, {artist}.',
  'Mm. {song} by {artist}. What a song.',
  'That one was {artist}, {song}.',
  '{song}. {artist}. Still sounds great.',
];

export const OUTRO_HIGH = ['That was {song} by {artist}, and wow, what a way to do it!', '{artist} with {song}! No skips, none.'];
export const OUTRO_LOW = ['That was {song}, by {artist}. Lovely.', 'Mm, {artist} there. {song}.'];

export const INTRO = [
  'Up next, it’s {artist} with {song}.',
  'Here’s {song} by {artist}.',
  'Coming up right now, {artist}. This is {song}.',
  "Let’s keep it going with {song}, from {artist}.",
  'This next one is {song} by {artist}.',
  'Stay right there, {artist} is up next with {song}.',
  "Here’s {artist}. {song}.",
];

export const INTRO_HIGH = ["Turn it up, it’s {artist} with {song}!", "Here we go. {song}, {artist}. Let’s go!"];
export const INTRO_LOW = ['Settle in for this one. {song}, by {artist}.', "Here’s something gentle. {artist}, {song}."];

export const TIME = [
  "It’s {time} on this {weekday} {part}.",
  'Right now it’s {time}.',
  'Quick time check: {time}.',
  "We’re at {time} on {weekday}.",
];

export const WEATHER = [
  'Out in {place} it’s {temp} degrees and {cond}.',
  '{Cond} in {place} right now, {temp} degrees.',
  'Weather check: {temp} degrees and {cond} in {place}.',
  'If you’re heading out in {place}, it’s {cond}, about {temp} degrees.',
];
export const WEATHER_NOPLACE = ['Outside it’s {temp} degrees and {cond}.', 'Weather check: {cond}, {temp} degrees.'];
export const WEATHER_RANGE = ['Today tops out at {high} with a low of {low}.', 'Look for a high of {high} today.'];
export const WEATHER_RAIN = ['There’s a {rain} percent chance of rain, so maybe grab a jacket.', 'Rain chance is {rain} percent. Umbrella weather, maybe.'];

export const CALENDAR = [
  'On your calendar: {event}.',
  'Heads up, you have {event}.',
  'Looking at your day, there’s {event}.',
  "Don’t forget, {event}.",
];

export const EMAIL = [
  'Quick heads-up, you have {email}.',
  'In your inbox, there’s {email}.',
  'New mail: {email}.',
];

export const NEWS = [
  'In the news from {source}: {headline}.',
  'Headline from {source}: {headline}.',
  'Here’s what {source} is reporting: {headline}.',
];

export const LIFE_TODAY = ['Big day today: {event}!', 'Today’s {event}. That deserves a song.', 'Hey, today is {event}.'];
export const LIFE_SOON = ['Mark it down, {event} is {when}.', 'Coming up {when}: {event}.', 'Just so you know, {event} is {when}.'];
export const LIFE_YEARS = ['{years} years. That’s something.', 'That makes it {years} years.'];

export const NOTE = ['And a note you left for us: {note}.', 'You asked us to mention this: {note}.', 'A little note from you: {note}.'];
export const REMINDER = ['Quick reminder for you: {text}, {when}.', 'Gentle reminder: {text}, {when}.', 'Before I forget: {text}, {when}.'];
export const FACT_LEAD = ['Fun fact for you.', 'Here’s a fun one.', 'Did you know this?', 'Little bit of music trivia.'];

export const STATION_ID = ["You’re tuned to {station}.", 'This is {station}, {freq} FM.', '{station}, right here with you.'];
export const OPENING = [
  '{greeting}, and welcome to {station}. I’m {host}.',
  '{greeting}! {host} here, and you’re listening to {station}.',
  'Welcome in. This is {station}, {freq} FM, and I’m {host}.',
];
export const OPENING_DUO = ['Joined as always by {cohost}.', 'And {cohost} is right here with me.', 'With me, as always, {cohost}.'];

export const REACT = [
  'Ha, I love that, {name}.',
  'You read my mind, {name}.',
  'Couldn’t agree more.',
  'Okay, that’s a good one.',
  'Right? Same here.',
  'See, this is why we do this.',
];
export const REACT_FUNNY = ['Bold take, {name}. I’ll allow it.', 'You say that every time, {name}. And you’re right every time.', 'Somebody give {name} a raise.'];
export const REACT_CALM = ['Mm, that’s a nice one.', 'I like that, {name}.', 'That feels right for this hour.'];
export const HANDOFF = ['{name}, take it away.', 'Over to you, {name}.', 'What do you think, {name}?'];

export const CALLIN_OPEN = [
  'We’ve got {listener} on the line!',
  'Oh, a call coming in. Hey {listener}!',
  'Phones are lit up. {listener}, you’re on the air.',
];

/** the same openers when we do not know the listener's name */
export const CALLIN_OPEN_ANON = [
  'We’ve got a caller on the line!',
  'Oh, a call coming in. Hey there, you’re on the air!',
  'Phones are lit up. Go ahead, you’re on the air.',
];
export const CALLIN_ECHO = ['You said: {said}. Love that.', '{said}. Thanks for calling in with that.', 'You told us: {said}. We hear you.'];
export const CALLIN_UPBEAT = ['Upbeat? I like your style. Let’s keep the energy up.', 'Say no more. Good energy is the whole point of this show.'];
export const CALLIN_HELLO = ['Hello right back to you, and to everyone listening!', 'Big hello from all of us here.'];
export const CALLIN_THANKS = ['Thanks for calling. Back to the music.', 'Keep those calls coming. Here’s more music.'];

export const CATCH_CHANCE = 0.3;

export const REQUEST_LEAD = ['Great request.', 'Love that request.', 'You asked, we listen.'];
export const REQUEST_APP_LEAD = ['Your assistant sent in a request.', 'A request just came in from your assistant.'];
export const REQUEST_FOUND = ['{song}{by} is up next.', 'Coming right up after this one: {song}{by}.', 'Found it. {song}{by} plays next.'];
/** the request is the next song and the intro names it: here it is not named (once per break) */
export const REQUEST_SOON = ['It’s coming right up.', 'You’ll hear it in a moment.', 'Stay right there, it’s next.'];
export const REQUEST_MISSING = [
  'I looked for {query}, but it isn’t in your music yet. Add it to your library and we’ll spin it.',
  'No {query} in your library yet, sorry. Add it and it’s yours.',
];
