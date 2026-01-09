export interface LibraryQuote {
  text: string;
  author: string;
  category: string;
  source?: 'local';
}

// Comprehensive collection of quotes aligned with the client-side catalogue.
export const DAILY_QUOTES_LIBRARY: LibraryQuote[] = [
  // Inspirational
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs", category: "inspirational", source: "local" },
  { text: "Life is what happens to you while you're busy making other plans.", author: "John Lennon", category: "inspirational", source: "local" },
  { text: "The future belongs to those who believe in the beauty of their dreams.", author: "Eleanor Roosevelt", category: "inspirational", source: "local" },
  { text: "It is during our darkest moments that we must focus to see the light.", author: "Aristotle", category: "inspirational", source: "local" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney", category: "inspirational", source: "local" },

  // Educational
  { text: "Education is the most powerful weapon which you can use to change the world.", author: "Nelson Mandela", category: "educational", source: "local" },
  { text: "The more that you read, the more things you will know. The more that you learn, the more places you'll go.", author: "Dr. Seuss", category: "educational", source: "local" },
  { text: "Tell me and I forget, teach me and I may remember, involve me and I learn.", author: "Benjamin Franklin", category: "educational", source: "local" },
  { text: "Learning never exhausts the mind.", author: "Leonardo da Vinci", category: "educational", source: "local" },
  { text: "The beautiful thing about learning is that nobody can take it away from you.", author: "B.B. King", category: "educational", source: "local" },

  // Motivational
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt", category: "motivational", source: "local" },
  { text: "The only impossible journey is the one you never begin.", author: "Tony Robbins", category: "motivational", source: "local" },
  { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill", category: "motivational", source: "local" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson", category: "motivational", source: "local" },
  { text: "The difference between ordinary and extraordinary is that little extra.", author: "Jimmy Johnson", category: "motivational", source: "local" },

  // Wisdom
  { text: "The only true wisdom is in knowing you know nothing.", author: "Socrates", category: "wisdom", source: "local" },
  { text: "Yesterday is history, tomorrow is a mystery, today is a gift of God, which is why we call it the present.", author: "Bill Keane", category: "wisdom", source: "local" },
  { text: "In the middle of difficulty lies opportunity.", author: "Albert Einstein", category: "wisdom", source: "local" },
  { text: "Be yourself; everyone else is already taken.", author: "Oscar Wilde", category: "wisdom", source: "local" },
  { text: "The journey of a thousand miles begins with one step.", author: "Lao Tzu", category: "wisdom", source: "local" },

  // Success
  { text: "Success is not how high you have climbed, but how you make a positive difference to the world.", author: "Roy T. Bennett", category: "success", source: "local" },
  { text: "The secret of success is to do the common thing uncommonly well.", author: "John D. Rockefeller Jr.", category: "success", source: "local" },
  { text: "Don't be afraid to give up the good to go for the great.", author: "John D. Rockefeller", category: "success", source: "local" },
  { text: "I find that the harder I work, the more luck I seem to have.", author: "Thomas Jefferson", category: "success", source: "local" },
  { text: "Success is walking from failure to failure with no loss of enthusiasm.", author: "Winston Churchill", category: "success", source: "local" },

  // Leadership
  { text: "A leader is one who knows the way, goes the way, and shows the way.", author: "John C. Maxwell", category: "leadership", source: "local" },
  { text: "The art of leadership is saying no, not saying yes. It is very easy to say yes.", author: "Tony Blair", category: "leadership", source: "local" },
  { text: "Leadership is not about being in charge. It is about taking care of those in your charge.", author: "Simon Sinek", category: "leadership", source: "local" },
  { text: "Innovation distinguishes between a leader and a follower.", author: "Steve Jobs", category: "leadership", source: "local" },
  { text: "The greatest leader is not necessarily the one who does the greatest things. He is the one that gets the people to do the greatest things.", author: "Ronald Reagan", category: "leadership", source: "local" },

  // Life Lessons
  { text: "Life is 10% what happens to you and 90% how you react to it.", author: "Charles R. Swindoll", category: "life", source: "local" },
  { text: "The purpose of our lives is to be happy.", author: "Dalai Lama", category: "life", source: "local" },
  { text: "You only live once, but if you do it right, once is enough.", author: "Mae West", category: "life", source: "local" },
  { text: "Many of life's failures are people who did not realize how close they were to success when they gave up.", author: "Thomas A. Edison", category: "life", source: "local" },
  { text: "Life is really simple, but we insist on making it complicated.", author: "Confucius", category: "life", source: "local" },

  // Perseverance
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius", category: "perseverance", source: "local" },
  { text: "Fall seven times, stand up eight.", author: "Japanese Proverb", category: "perseverance", source: "local" },
  { text: "The difference between a successful person and others is not a lack of strength, not a lack of knowledge, but rather a lack of will.", author: "Vince Lombardi", category: "perseverance", source: "local" },
  { text: "Perseverance is not a long race; it is many short races one after the other.", author: "Walter Elliot", category: "perseverance", source: "local" },
  { text: "Never give up on a dream just because of the time it will take to accomplish it. The time will pass anyway.", author: "Earl Nightingale", category: "perseverance", source: "local" },

  // Creativity
  { text: "Creativity is intelligence having fun.", author: "Albert Einstein", category: "creativity", source: "local" },
  { text: "The secret to creativity is knowing how to hide your sources.", author: "Pablo Picasso", category: "creativity", source: "local" },
  { text: "Innovation is the ability to see change as an opportunity - not a threat.", author: "Steve Jobs", category: "creativity", source: "local" },
  { text: "Creativity takes courage.", author: "Henri Matisse", category: "creativity", source: "local" },
  { text: "The creative adult is the child who survived.", author: "Ursula K. Le Guin", category: "creativity", source: "local" },

  // Happiness
  { text: "Happiness is not something ready made. It comes from your own actions.", author: "Dalai Lama", category: "happiness", source: "local" },
  { text: "The secret of happiness is freedom, the secret of freedom is courage.", author: "Carrie Jones", category: "happiness", source: "local" },
  { text: "Happiness depends upon ourselves.", author: "Aristotle", category: "happiness", source: "local" },
  { text: "The best way to cheer yourself up is to try to cheer somebody else up.", author: "Mark Twain", category: "happiness", source: "local" },
  { text: "Happiness is when what you think, what you say, and what you do are in harmony.", author: "Mahatma Gandhi", category: "happiness", source: "local" },
];
