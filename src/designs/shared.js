export const GAME_ICONS = {
  alias: '💬',
  never: '🙌',
  truth: '⁉️',
  whoofus: '👯',
  spy: '🕵️',
  crocodile: '🤌',
  five: '⏱️',
  memes: '😂',
  whoami: '❔',
  most: '✅',
  fact: '🔎',
  mafia: '🎭',
  bunker: '🛡️',
  associations: '🧠',
  hot_seat: '🔥',
  taboo: '🚫',
}

export const CATEGORY_META = {
  объяснялки: { icon: '🎙️', label: 'Объяснялки', tone: 'violet' },
  вопросы: { icon: '💬', label: 'Вопросы', tone: 'pink' },
  действия: { icon: '⚡', label: 'Действия', tone: 'amber' },
  голосование: { icon: '✅', label: 'Голосование', tone: 'cyan' },
  детектив: { icon: '🕵️', label: 'Детектив', tone: 'green' },
  скорость: { icon: '⏱️', label: 'На скорость', tone: 'red' },
  мемы: { icon: '😂', label: 'Мемы', tone: 'amber' },
  угадайка: { icon: '❔', label: 'Угадайка', tone: 'cyan' },
  ролевые: { icon: '🎭', label: 'Ролевые', tone: 'orange' },
  слова: { icon: '🧠', label: 'Слова', tone: 'blue' },
}

export const VIBES = [
  { id: 'quick', label: 'Быстрая', icon: '⚡', hint: '3-5 минут на разогрев' },
  { id: 'company', label: 'Компания', icon: '👥', hint: 'для шумного круга' },
  { id: 'duo', label: 'На двоих', icon: '💫', hint: 'короткие дуэли' },
  { id: 'funny', label: 'Смешной', icon: '😂', hint: 'больше мемов' },
  { id: 'spicy', label: 'Провокационный', icon: '🔥', hint: 'острые вопросы' },
  { id: 'chill', label: 'Спокойный', icon: '🌙', hint: 'без давления' },
]

export const PARTY_TASKS = [
  {
    type: 'Голосование',
    icon: '✅',
    title: 'Кто из вас скорее всего опоздает на собственную свадьбу?',
    action: 'Голосовать',
  },
  {
    type: '5 секунд',
    icon: '⏱️',
    title: 'Назови три вещи, которые нельзя делать на первом свидании.',
    action: 'Запустить таймер',
  },
  {
    type: 'Правда',
    icon: '⁉️',
    title: 'Какой твой самый странный комплимент, который реально сработал?',
    action: 'Ответить',
  },
  {
    type: 'Мем-батл',
    icon: '😂',
    title: 'Покажи лицо человека, который сказал “я на пять минут”.',
    action: 'Выбрать мем',
  },
]

export const PLAYERS = ['Аня', 'Дима', 'Саша', 'Лера', 'Макс']

export const REACTIONS = ['😂', '😳', '🔥', '💀', '🕵️']

export function gameIcon(game) {
  return GAME_ICONS[game.id] || game.emoji
}
