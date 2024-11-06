const express = require('express'); 
const cors = require('cors'); 
const admin = require('firebase-admin'); 
const multer = require('multer'); 
const { v4: uuidv4 } = require('uuid'); 
const fetch = require('node-fetch');
const fs = require('fs');
const cron = require('node-cron');
const moment = require('moment-timezone');
const TelegramBot = require('node-telegram-bot-api');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

moment.tz.load(require('moment-timezone/data/packed/latest.json'));

require('dotenv').config();

const serviceAccount = require('./spa-salon-tg-firebase-adminsdk-fjzow-ceb0765413.json');

admin.initializeApp({ 
  credential: admin.credential.cert(serviceAccount), 
  storageBucket: 'spa-salon-tg.appspot.com' 
});

const db = admin.firestore(); 
const bucket = admin.storage().bucket(); 
const app = express(); 
const port = process.env.PORT || 3000;

app.use(cors()); 
app.use(express.json());

const storage = multer.memoryStorage(); 
const upload = multer({ storage });



app.post('/check-password', (req, res) => {
    const { password } = req.body;
    const correctPassword = process.env.ADMIN_PASSWORD; 

    if (password === correctPassword) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});



//создание события
app.get('/get-studios-with-timezone', async (req, res) => {
    try {
        const studiosSnapshot = await db.collection('studios').get();
        const studiosData = [];

        studiosSnapshot.forEach(doc => {
            const data = doc.data();
            studiosData.push({
                name: doc.id,
                timeZone: data.timeZone
            });
        });

        res.json({ studios: studiosData });
    } catch (error) {
        console.error('Ошибка при получении студий с временными зонами:', error);
        res.status(500).json({ error: 'Ошибка при получении данных о студиях' });
    }
});

async function getTelegramChatId(studioName) {
    if (!studioName || studioName.trim() === '') {
        throw new Error('Studio name is empty or invalid');
    }

    console.log('Получение chatId для студии:', studioName);
    const studioDoc = await db.collection('studios').doc(studioName).get();

    if (!studioDoc.exists) {
        throw new Error(`Studio with name ${studioName} does not exist`);
    }

    const studioData = studioDoc.data();
    const chatId = studioData.chatId;

    if (!chatId) {
        throw new Error(`chatId is not defined for studio ${studioName}`);
    }

    return chatId;
}

app.get('/get-chat-id/:studioName', async (req, res) => {
    const { studioName } = req.params;

    try {
        const studioDoc = await db.collection('studios').doc(studioName).get();
        
        if (!studioDoc.exists) {
            return res.status(404).json({ error: 'Studio not found' });
        }

        const studioData = studioDoc.data();
        const chatId = studioData.chatId;

        res.json({ chatId });
    } catch (error) {
        console.error('Error getting chatId:', error);
        res.status(500).json({ error: 'Error getting chatId' });
    }
});

app.get('/get-all-chat-ids', async (req, res) => {
    try {
        const studiosSnapshot = await db.collection('studios').get();
        const chatIds = [];
        const studioNames = [];

        studiosSnapshot.forEach(doc => {
            const studioData = doc.data();
            chatIds.push(studioData.chatId);
            studioNames.push(doc.id);
        });

        res.json({ chatIds, studioNames });
    } catch (error) {
        console.error('Error getting all chatIds:', error);
        res.status(500).json({ error: 'Error getting all chatIds' });
    }
});


function convertToISOMSK(dateTime, timezone) {
    const mskTime = moment.tz(dateTime, timezone).tz('Europe/Moscow').format();
    return mskTime;
}


app.post('/create-event', async (req, res) => {
    const { chatIds, studioNames, name, time, description, warningTime, report, period, addReminder } = req.body;

    if (!chatIds || !name || !time || !description || studioNames.length === 0) {
        return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    try {
        const studioTimezones = await Promise.all(studioNames.map(async studioName => {
            const studioDoc = await db.collection('studios').doc(studioName).get();
            return studioDoc.exists ? studioDoc.data().timeZone : null;
        }));

        if (studioTimezones.includes(null)) {
            return res.status(400).json({ error: 'Ошибка: не удалось получить временную зону для одной или нескольких студий' });
        }

        const eventTimesByStudio = studioNames.map((studioName, index) => {
            const timezoneOffset = parseFloat(studioTimezones[index]);
            const eventTimeWithOffset = moment(time, "DD.MM.YYYY HH:mm:ss")
                .add(timezoneOffset, 'hours')
                .format("YYYY-MM-DDTHH:mm:ss[Z]");

            // Конвертируем время предупреждения аналогично
            const warningTimeWithOffset = warningTime
                ? moment(warningTime, "DD.MM.YYYY HH:mm:ss")
                    .add(timezoneOffset, 'hours')
                    .format("YYYY-MM-DDTHH:mm:ss[Z]") 
                : null;
        
            return {
                studioName,
                time: eventTimeWithOffset,
                description,
                warningTime: warningTimeWithOffset,
                report,
                period,
                addReminder,
                chatId: chatIds[index],
                name
            }
        });
      
        if (period && report && addReminder) {
            // Записываем событие как в report-events, так и в period-events
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const reportEventRef = db.collection('report-period-events').doc(studioName).collection('events').doc(name);
                    await reportEventRef.set({
                        time,
                        warningTime,
                        description,
                        chatId
                    });

//                     const periodicEventRef = db.collection('period-events').doc(studioName).collection('events').doc(name);
//                     await periodicEventRef.set({
//                         time,
//                         warningTime,
//                         description,
//                         chatId
//                     });

                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId, period: 'ok' });
                } catch (err) {
                    console.error(`Ошибка при записи в report-events или period-events для студии ${studioName}:`, err);
                }
            }));
        } else if (report && addReminder) {
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const reportEventRef = db.collection('report-events').doc(studioName).collection('events').doc(name);
                    await reportEventRef.set({
                        time,
                        warningTime,
                        description,
                        chatId
                    });

                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId });
                  
                    const warningEventRef = db.collection('warning-events').doc(studioName).collection('events').doc(name);
                    await warningEventRef.set({ studioName, name, time, description, warningTime, chatId });
                } catch (err) {
                    console.error(`Ошибка при записи в report-events для студии ${studioName}:`, err);
                }
            }));
        } else if (report) {
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const reportEventRef = db.collection('report-events').doc(studioName).collection('events').doc(name);
                    await reportEventRef.set({
                        time,
                        warningTime,
                        description,
                        chatId
                    });

                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId });
                } catch (err) {
                    console.error(`Ошибка при записи в report-events для студии ${studioName}:`, err);
                }
            }));
        } else if (period && addReminder) {
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const periodicEventRef = db.collection('period-events').doc(studioName).collection('events').doc(name);
                    await periodicEventRef.set({
                        time,
                        warningTime,
                        description,
                        chatId
                    });
                  
                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId, period: 'ok' });
                } catch (err) {
                    console.error('Ошибка при записи в period-events:', err);
                }
            }));
        } else if (addReminder) {
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const warningEventRef = db.collection('warning-events').doc(studioName).collection('events').doc(name);
                    await warningEventRef.set({
                        time,
                        warningTime,
                        description,
                        chatId
                    });

                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId });
                } catch (err) {
                    console.error(`Ошибка при записи в warning-events для студии ${studioName}:`, err);
                }
            }));
        } else {
            await Promise.all(eventTimesByStudio.map(async ({ studioName, time, warningTime, chatId }) => {
                try {
                    const eventRef = db.collection('events').doc(studioName).collection('events').doc(name);
                    await eventRef.set({ studioName, name, time, description, warningTime, chatId });
                } catch (err) {
                    console.error(`Ошибка при записи в events для студии ${studioName}:`, err);
                }
            }));
        }

        await Promise.all(chatIds.map(async (chatId) => {
            const studioIndex = chatIds.indexOf(chatId);
            const studioName = studioNames[studioIndex];
            const eventTime = eventTimesByStudio[studioIndex].time;

            const formattedTime = moment(eventTime).utc().format("DD.MM.YYYY HH:mm:ss");

            let message = `Новое событие! \n\nНазвание: ${name}.\nВремя: ${formattedTime}\nОписание: ${description}`;
          
            if (report && addReminder) {
                message += `\n\nДанное событие необходимо закрыть отчетом!!!`;
            } else if (period && report && addReminder) {
                message += `\n\nДанное событие необходимо закрыть отчетом!!!`;
            } else if (report) {
                message += `\n\nДанное событие необходимо закрыть отчетом!!!`;
            }
          
            if (period && addReminder) {
                console.log('Сообщение не отправляется, так как установлены флаги period и addReminder');
                return;
            }

            try {
                const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                const response = await fetch(telegramUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
                });

                if (!response.ok) {
                    throw new Error(`Ошибка при отправке сообщения в чат ${chatId}: ${await response.text()}`);
                }
            } catch (err) {
                console.error('Ошибка при отправке сообщения в Telegram:', err);
            }
        }));


        res.json({ message: 'Событие создано успешно!' });
    } catch (error) {
        console.error('Ошибка при создании события:', error);
        res.status(500).json({ error: 'Ошибка при создании события' });
    }
});








// Закрытие отчетом
  //крон для report-events
cron.schedule('0 */3 * * *', async () => { 
    const currentTime = moment().utc().toISOString();
    // console.log(`Текущее время: ${currentTime}`);

    try {
        const reportsRef = db.collection('report-events');
        const studiosSnapshot = await reportsRef.listDocuments();

        // console.log(`Количество студий: ${studiosSnapshot.length}`);

        const deletePromises = [];

        for (const studioDocRef of studiosSnapshot) {
            const studioDoc = await studioDocRef.get();
            const studioName = studioDoc.id;
            // console.log(`Обработка студии: ${studioName}`);
            const eventsRef = reportsRef.doc(studioName).collection('events');
            const eventsSnapshot = await eventsRef.get();
            // console.log(`Количество событий в студии "${studioName}": ${eventsSnapshot.size}`);

            eventsSnapshot.forEach(async (eventDoc) => {
                const { chatId, description, time } = eventDoc.data(); // Убрали warningTime
                const eventName = eventDoc.id;
                const formattedEventTime = moment(time).format('DD.MM.YYYY HH:mm:ss');
                const message = `Напоминание! \n\nНазвание: ${eventName}.\nВремя: ${formattedEventTime}\nОписание: ${description}\n\nДанное событие необходимо закрыть отчетом!!!`;
                // console.log(`Отправка сообщения в чат ${chatId}: ${message}`);

                const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                try {
                    const response = await fetch(telegramUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: message,
                            parse_mode: 'Markdown',
                        }),
                    });

                    const data = await response.json();
                    // console.log(`Ответ от Telegram: ${JSON.stringify(data)}`);

                    if (!response.ok) {
                        console.error(`Ошибка при отправке сообщения: ${data.description}`);
                    }
                } catch (sendError) {
                    console.error(`Ошибка при отправке сообщения: ${sendError}`);
                }

                // deletePromises.push(eventsRef.doc(eventDoc.id).delete());
                // console.log(`Событие "${eventName}" будет удалено из базы данных.`);
            });
        }

        await Promise.all(deletePromises);
        // console.log(`Удалено событий: ${deletePromises.length}`);
    } catch (error) {
        console.error('Ошибка отправки напоминаний:', error);
    }
});





//крон для периодиечских событий с отчетом(report-period-events)
cron.schedule('0 */3 * * *', async () => {
    const currentTime = moment().utc().toISOString(); // Текущее время в UTC
    const currentDate = moment().format('YYYY-MM-DD'); // Текущая дата в формате YYYY-MM-DD

    try {
        const reportsRef = db.collection('report-period-events');
        const studiosSnapshot = await reportsRef.listDocuments();

        const sendReminderPromises = [];

        for (const studioDocRef of studiosSnapshot) {
            const studioDoc = await studioDocRef.get();
            const studioName = studioDoc.id;
            const eventsRef = reportsRef.doc(studioName).collection('events');
            const eventsSnapshot = await eventsRef.get();

            eventsSnapshot.forEach(async (eventDoc) => {
                const { chatId, description, time } = eventDoc.data();
                const eventName = eventDoc.id;

                const eventDate = moment(time).format('YYYY-MM-DD');

                if (eventDate === currentDate) {
                    const formattedEventTime = moment(time).format('DD.MM.YYYY HH:mm:ss');
                    const message = `Напоминание! \n\nНазвание: ${eventName}.\nВремя: ${formattedEventTime}\nОписание: ${description}\n\nДанное событие необходимо закрыть отчетом!!!`;

                    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                    try {
                        const response = await fetch(telegramUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                chat_id: chatId,
                                text: message,
                                parse_mode: 'Markdown',
                            }),
                        });

                        const data = await response.json();
                        if (!response.ok) {
                            console.error(`Ошибка при отправке сообщения: ${data.description}`);
                        }
                    } catch (sendError) {
                        console.error(`Ошибка при отправке сообщения: ${sendError}`);
                    }
                }
            });
        }
      
        await Promise.all(sendReminderPromises);
    } catch (error) {
        console.error('Ошибка отправки напоминаний:', error);
    }
});





function extractEventName(message) {
    const regex = /Название:\s*([^\.]+)/i;
    const match = message.match(regex);
    
    if (match && match[1]) {
        return match[1].trim();
    }
    return null;
}


async function deleteEvent(eventName, chatId) {
    // console.log(`Поиск события "${eventName}" по всем студиям.`);

    try {
        const studiosRef = db.collection('report-events');
        const studiosDocs = await studiosRef.listDocuments();

        if (studiosDocs.length === 0) {
            console.log("Студии не найдены.");
            return false;
        }

        let eventFound = false;

        for (const studioDoc of studiosDocs) {
            const studioName = studioDoc.id;
            // console.log(`Проверка студии: "${studioName}"`);

            const eventsRef = db.collection('report-events').doc(studioName).collection('events');
            const eventsRefAll = db.collection('events').doc(studioName).collection('events');
            const warningEventsRef = db.collection('warning-events').doc(studioName).collection('events');
            const periodEventsRef = db.collection('report-period-events').doc(studioName).collection('events');
          
            const eventDoc = await eventsRef.doc(eventName).get();
            const warningEventDoc = await warningEventsRef.doc(eventName).get();
            const periodEventDoc = await periodEventsRef.doc(eventName).get();

            if (eventDoc.exists) {
                // console.log(`Событие "${eventName}" найдено в студии "${studioName}".`);

                const eventData = eventDoc.data();
                const eventChatId = eventData.chatId;
                // console.log(`Сравнение chatId. Полученный chatId: ${chatId}, chatId из БД: ${eventChatId}`);

                if (eventChatId === String(chatId)) {
                    await eventsRef.doc(eventName).delete();
                    await eventsRefAll.doc(eventName).delete();
                  
                    if (warningEventDoc.exists) {
                        await warningEventsRef.doc(eventName).delete();
                        console.log(`Событие "${eventName}" удалено из студии "${studioName}" в warning-events.`);
                    }
                    // console.log(`Событие "${eventName}" удалено из студии "${studioName}".`);


                    eventFound = true;
                } else {
                    console.log(`chatId не совпадает. Событие "${eventName}" в студии "${studioName}" не удалено.`);
                }
            } else if (periodEventDoc.exists) {
                const periodEventData = periodEventDoc.data();
                const periodEventChatId = periodEventData.chatId;
              
                if (periodEventChatId === String(chatId)) {
                  
                    await eventsRefAll.doc(eventName).delete();
                    await periodEventsRef.doc(eventName).delete();
                  
                    eventFound = true;
                }
            } else {
                console.log(`Событие "${eventName}" не найдено в студии "${studioName}".`);
            }
        }

        if (!eventFound) {
            console.log(`Событие "${eventName}" не найдено или chatId не совпадает во всех студиях.`);
        }

        return eventFound;
    } catch (error) {
        console.error('Ошибка при попытке найти или удалить событие:', error);
        return false;
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    if (msg.reply_to_message && msg.text) {
        const text = msg.text.toLowerCase();

        if (text.includes('отчет')) {
            const eventName = extractEventName(msg.reply_to_message.text);
            if (!eventName) {
                bot.sendMessage(chatId, 'Похоже это безимянное событие. Пожалуйста обратитесь к администратору для сохранения отчета!');
                return;
            }

            try {
                const eventDeleted = await deleteEvent(eventName, chatId);
                if (eventDeleted) {
                    bot.sendMessage(chatId, `Отчет по событию: "${eventName}" успешно сохранен!`);
                } else {
                    bot.sendMessage(chatId, `Отчет по событию: "${eventName}" не может быть сохранен. Пожалуйста обратитесь к администратору для сохранения отчета!`);
                }
            } catch (error) {
                console.error('Ошибка при удалении события:', error);
                bot.sendMessage(chatId, 'Ошибка при сохранении отчета!');
            }
        }
    }
});








//крон для событий с напоминанием
cron.schedule('* * * * *', async () => {
    const currentTimeUTC = moment().utc();
    const currentTimeMSK = currentTimeUTC.clone().add(3, 'hours').toISOString();
    // console.log(`Текущее время (MSK): ${currentTimeMSK}`);

    try {
        const studiosRef = db.collection('warning-events');
        const studiosSnapshot = await studiosRef.listDocuments();

        const deletePromises = [];

        for (const studioDocRef of studiosSnapshot) {
            const studioDoc = await studioDocRef.get();
            const studioName = studioDoc.id;
            const eventsRef = studiosRef.doc(studioName).collection('events');
            const eventsSnapshot = await eventsRef.get();

            eventsSnapshot.forEach(async (eventDoc) => {
                const { chatId, description, time, warningTime } = eventDoc.data();
                const eventName = eventDoc.id;
                const warningDateTimeUTC = moment(warningTime).utc().toISOString(); 
                // console.log(`Обработка события: ${eventName}, Время предупреждения: ${warningDateTimeUTC}, Chat ID: ${chatId}`);

                if (currentTimeMSK >= warningDateTimeUTC) { // Сравнение с московским временем
                    const formattedEventTime = moment(time).format('DD.MM.YYYY HH:mm:ss');
                    const message = `Напоминание! \n\nНазвание: ${eventName}.\nВремя: ${formattedEventTime}\nОписание: ${description}`;
                    
                    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                    try {
                        const response = await fetch(telegramUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                chat_id: chatId,
                                text: message,
                                parse_mode: 'Markdown',
                            }),
                        });

                        const data = await response.json();

                        if (!response.ok) {
                            console.error(`Ошибка при отправке сообщения: ${data.description}`);
                        }
                    } catch (sendError) {
                        console.error(`Ошибка при отправке сообщения: ${sendError}`);
                    }

                    deletePromises.push(eventsRef.doc(eventDoc.id).delete());
                } else {
                    // console.log(`Событие "${eventName}" еще не пришло. Текущая дата: ${currentTimeMSK}, Время предупреждения: ${warningDateTimeUTC}`);
                }
            });
        }

        await Promise.all(deletePromises);
    } catch (error) {
        console.error('Ошибка отправки напоминаний:', error);
    }
});






// переодические события в period-events
cron.schedule('* * * * *', async () => {
    const currentTimeUTC = moment().utc();  // Текущее время в UTC
    const currentTimeMSK = currentTimeUTC.clone().add(3, 'hours');  // Преобразуем в МСК

    // console.log('Текущее время (UTC):', currentTimeUTC.format());
    // console.log('Текущее время (MSK):', currentTimeMSK.format()); 

    try {
        const periodicEventsRef = db.collection('period-events');
        const studiosSnapshot = await periodicEventsRef.listDocuments();

        for (const studioDocRef of studiosSnapshot) {
            const studioDoc = await studioDocRef.get();
            const studioName = studioDoc.id;
            const eventsRef = periodicEventsRef.doc(studioName).collection('events');
            const eventsSnapshot = await eventsRef.listDocuments();

            for (const eventDocRef of eventsSnapshot) {
                const eventDoc = await eventDocRef.get();
                const { chatId, description, warningTime } = eventDoc.data();
                const eventName = eventDocRef.id;

                // console.log(`Обработка события: ${eventName}, Время предупреждения (MSK): ${warningTime}`);

                try {
                    // WarningTime уже в МСК, поэтому сразу сравниваем его с текущим временем в МСК
                    const warningMoment = moment(warningTime, 'YYYY-MM-DDTHH:mm:ss.SSSZ'); 
                    // console.log(`Время предупреждения (MSK): ${warningMoment.format()}`); 

                    // Сравниваем время предупреждения с текущим временем в МСК
                    if (currentTimeMSK.isSame(warningMoment, 'minute')) {
                        // console.log(`Отправка напоминания для события: ${eventName}`);

                        const message = `Напоминание! \n\nНазвание: ${eventName}.\nОписание: ${description}\n\nЭто периодическое событие!`;

                        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                        const response = await fetch(telegramUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                chat_id: chatId,
                                text: message,
                                parse_mode: 'Markdown',
                            }),
                        });

                        if (!response.ok) {
                            console.error(`Ошибка при отправке сообщения в Telegram для события ${eventName}: ${await response.text()}`);
                        }
                    } else {
                        // console.log(`Время для события ${eventName} не совпадает с текущим (MSK) - не отправляем напоминание.`);
                    }
                } catch (error) {
                    console.error(`Ошибка при преобразовании даты для события ${eventName}:`, error.message);
                }
            }
        }
    } catch (error) {
        console.error('Ошибка отправки напоминаний:', error);
    }
});








app.delete('/delete-event', async (req, res) => {
    const { studioName, eventName } = req.body;

    const collections = ['events', 'period-events', 'warning-events', 'report-events', 'report-period-events'];
    let eventFound = false;

    try {
        for (const collection of collections) {
            const collectionRef = db.collection(collection);
            const studioRef = collectionRef.doc(studioName).collection('events').doc(eventName);
            const eventDoc = await studioRef.get();

            if (eventDoc.exists) {
                await studioRef.delete();
                eventFound = true;
            }
        }

        if (eventFound) {
            return res.json({ message: 'Событие удалено!' });
        } else {
            return res.status(404).json({ error: 'Событие не найдено' });
        }
        
    } catch (error) {
        console.error('Ошибка удаления события:', error);
        res.status(500).json({ error: 'Ошибка удаления события' });
    }
});


















async function getAllStudios() {
    try {
        const studiosSnapshot = await db.collection('studios').get();
        const studios = studiosSnapshot.docs.map(doc => doc.id);
        return studios;
    } catch (error) {
        console.error('Ошибка при получении студий:', error);
        throw new Error('Ошибка при получении студий');
    }
}


app.post('/upload', upload.fields([
    { name: 'files', maxCount: 1 },
    { name: 'additionalFiles', maxCount: 10 }
]), async (req, res) => {
    const { title, description, keywords, studioName } = req.body;
    const primaryFile = req.files['files'] ? req.files['files'][0] : null;
    const additionalFiles = req.files['additionalFiles'] || [];
    let studios = [];

    if (req.body.selectAllStudios === 'true') {
        studios = await getAllStudios();
    } else {
        studios.push(req.body.studioName);
    }

    if (studios.length === 0 || !title || !description) {
        return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    try {
        const fileUrls = [];
        const additionalFileUrls = [];

        if (primaryFile) {
            const originalFileName = decodeURIComponent(Buffer.from(primaryFile.originalname, 'latin1').toString('utf-8'));
            const fileName = `${studioName}/${title}/file_${Date.now()}_/!/${originalFileName}`;
            const fileUpload = bucket.file(fileName);
            await fileUpload.save(primaryFile.buffer, { contentType: primaryFile.mimetype });
            await fileUpload.makePublic();

            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            fileUrls.push(publicUrl);
        } else {
            fileUrls.push('');
        }

        for (const file of additionalFiles) {
            const originalAdditionalFileName = decodeURIComponent(Buffer.from(file.originalname, 'latin1').toString('utf-8'));
            const additionalFileName = `${studioName}/${title}/additional_${Date.now()}_/!/${originalAdditionalFileName}`;
            const fileUpload = bucket.file(additionalFileName);
            await fileUpload.save(file.buffer, { contentType: file.mimetype });
            await fileUpload.makePublic();

            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${additionalFileName}`;
            additionalFileUrls.push(publicUrl);
        }

        const formattedKeywords = keywords ? keywords.toLowerCase().replace(/\s+/g, '').split(';').join(';') : '';

        for (const studio of studios) {
            if (!studio) continue;

            await db.collection('instructions').doc(studio).collection('titles').doc(title).set({
                studioName: studio,
                title,
                description,
                keywords: formattedKeywords,
                fileUrls,
                additionalFileUrls
            });
        }

        res.json({ message: 'Инструкция успешно загружена!' });
    } catch (error) {
        console.error('Ошибка загрузки файла:', error);
        res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
});




app.get('/get-instruction', async (req, res) => {
    const { studioName, title } = req.query;
    
    // console.log(`Получен запрос на инструкцию: studioName=${studioName}, title=${title}`);

    try {
        const instruction = await db.collection('instructions')
            .doc(studioName)
            .collection('titles')
            .doc(title)
            .get();

        if (!instruction.exists) {
            console.warn('Инструкция не найдена:', studioName, title);
            return res.status(404).json({ error: 'Инструкция не найдена' });
        }

        res.json(instruction.data());
    } catch (error) {
        console.error('Ошибка получения инструкции:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});




app.post('/update-instruction', upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'additionalFiles', maxCount: 10 }
]), async (req, res) => {
    const { studioName, title, description, keywords } = req.body;
    const file = req.files['file'] ? req.files['file'][0] : null;
    const additionalFiles = req.files['additionalFiles'] || [];

    // console.log('Received data:', { studioName, title, description, keywords, file, additionalFiles });

    if (!studioName || !title) {
        return res.status(400).json({ error: 'Studio name and title are required.' });
    }

    try {
        const updateData = {};

        if (description) updateData.description = description;
        if (keywords) updateData.keywords = keywords;

        const instructionDoc = await db.collection('instructions')
            .doc(studioName)
            .collection('titles')
            .doc(title)
            .get();
        
        const existingData = instructionDoc.data();
        
        if (file) {
            const originalFileName = decodeURIComponent(Buffer.from(file.originalname, 'latin1').toString('utf-8'));

            const fileName = `${studioName}/${title}/file_${Date.now()}_/!/${originalFileName}`;
            const newFile = bucket.file(fileName);
            await newFile.save(file.buffer, { contentType: file.mimetype });

            await newFile.makePublic();

            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            updateData.fileUrls = [publicUrl];
        } else {
            updateData.fileUrls = existingData.fileUrls || [];
        }

        if (additionalFiles.length > 0) {
            const additionalFileUrls = [];
            for (const additionalFile of additionalFiles) {
                const originalAdditionalFileName = decodeURIComponent(Buffer.from(additionalFile.originalname, 'latin1').toString('utf-8'));

                const additionalFileName = `${studioName}/${title}/additional_${Date.now()}_/!/${originalAdditionalFileName}`;
                const newAdditionalFile = bucket.file(additionalFileName);
                await newAdditionalFile.save(additionalFile.buffer, { contentType: additionalFile.mimetype });

                await newAdditionalFile.makePublic();

                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${additionalFileName}`;
                additionalFileUrls.push(publicUrl);
            }
            updateData.additionalFileUrls = additionalFileUrls;
        } else {
            updateData.additionalFileUrls = [];
        }

        await db.collection('instructions')
            .doc(studioName)
            .collection('titles')
            .doc(title)
            .set(updateData, { merge: true });

        res.json({ message: 'Инструкция успешно обновлена' });
    } catch (error) {
        console.error('Ошибка обновления инструкции:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});







app.get('/search', async (req, res) => {
    const query = req.query.query ? req.query.query.toLowerCase() : '';
    const studioName = req.query.studioName;

    if (!studioName) {
        return res.status(400).json({ error: 'Необходимо указать студию' });
    }

    try {
        const instructionsRef = db.collection('instructions').doc(studioName).collection('titles');
        const snapshot = await instructionsRef.get();

        const results = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const formattedKeywords = data.keywords ? data.keywords.toLowerCase() : '';

            if (!query || data.title.toLowerCase().includes(query) || formattedKeywords.includes(query)) {
                results.push({
                    title: data.title,
                    description: data.description,
                    fileUrls: data.fileUrls || [],
                    additionalFileUrls: data.additionalFileUrls || []
                });
            }
        });

        res.json(results);
    } catch (error) {
        console.error('Ошибка поиска инструкций:', error);
        res.status(500).json({ error: 'Ошибка поиска инструкций' });
    }
});





app.delete('/delete-instruction', async (req, res) => {
    const { studioName, instructionName } = req.body;

    if (!studioName || !instructionName) {
        return res.status(400).json({ error: 'Не указано название студии или инструкции' });
    }

    try {
        const instructionRef = db.collection('instructions').doc(studioName).collection('titles').doc(instructionName);
        const doc = await instructionRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Инструкция не найдена' });
        }

        await instructionRef.delete();
        return res.status(200).json({ message: 'Инструкция удалена' });

    } catch (error) {
        console.error('Ошибка при удалении инструкции:', error);
        return res.status(500).json({ error: 'Ошибка удаления инструкции' });
    }
});






app.get('/all-instructions', async (req, res) => {
    try {
        const instructionsRef = db.collectionGroup('titles');
        const snapshot = await instructionsRef.get();
        
        const instructions = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            instructions.push({
                studioName: doc.ref.parent.parent.id,
                title: data.title,
                description: data.description,
                fileUrls: data.fileUrls || []
            });
        });

        res.json(instructions);
    } catch (error) {
        console.error('Ошибка получения инструкций:', error);
        res.status(500).json({ error: 'Ошибка получения инструкций' });
    }
});









app.get('/events', async (req, res) => {
  const studioName = req.query.studioName;

  if (!studioName) {
    console.error("Ошибка: Не указан studioName");
    return res.status(400).json({ error: 'Необходимо указать studioName' });
  }

  try {
    const events = [];

    const studioRef = db.collection('studios').doc(studioName);
    const studioDoc = await studioRef.get();

    if (!studioDoc.exists) {
      console.error(`Ошибка: Студия с именем ${studioName} не найдена`);
      return res.status(404).json({ error: 'Студия не найдена' });
    }

    const studioData = studioDoc.data();
    const timeZone = studioData.timeZone || "+0"; // Если timeZone не задан, по умолчанию будет "+0"
    console.log(`Time zone для студии ${studioName}: ${timeZone}`);

    const eventsRef = db.collection('events').doc(studioName).collection('events');
    const eventDocs = await eventsRef.listDocuments();

    if (eventDocs.length === 0) {
      console.log(`Нет событий в коллекции для студии: ${studioName}`);
    }

    const currentDateTime = new Date();
    const currentYear = currentDateTime.getFullYear();
    const currentMonth = currentDateTime.getMonth();

    for (const docRef of eventDocs) {
      const doc = await docRef.get();
      if (doc.exists) {
        const eventData = doc.data();
        const event = {
          id: doc.id,
          name: eventData.name,
          description: eventData.description,
          time: eventData.time,
        };

        if (eventData.time) {
          let eventTime = new Date(eventData.time); 
          console.log(`Original time for event ${doc.id} (String): ${eventTime}`);

          const offset = parseInt(timeZone, 10); 
          eventTime.setHours(eventTime.getHours() + offset - 3);

          if (eventData.period === 'ok') {
            eventTime.setFullYear(currentYear, currentMonth);

            const options = {
              timeZone: 'Europe/Moscow',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false 
            };

            const formattedDate = eventTime.toLocaleString('ru-RU', options).replace(',', '');
            event.time = formattedDate;
            console.log(`Formatted time for event ${doc.id}: ${event.time}`);
          } else {
            event.time = eventTime.toISOString(); 
          }
        }

        events.push(event); 
      } else {
        console.error(`Документ с ID ${docRef.id} не существует`);
      }
    }

    events.sort((a, b) => new Date(a.time) - new Date(b.time));

    console.log(`Возвращаем ${events.length} событий`);
    res.json(events);
  } catch (error) {
    console.error('Ошибка при получении событий:', error);
    res.status(500).json({ error: 'Ошибка получения событий' });
  }
});









app.get('/all-events', async (req, res) => {
    try {
        const eventsRef = db.collectionGroup('events');
        const snapshot = await eventsRef.get();
        
        let events = [];

        snapshot.forEach(doc => {
            const eventData = doc.data();
            const studioName = doc.ref.parent.parent.id;
            events.push({
                ...eventData,
                studioName 
            });
        });

        events.sort((a, b) => new Date(a.time) - new Date(b.time));

        res.json(events);
    } catch (error) {
        console.error('Ошибка получения всех событий:', error);
        res.status(500).json({ error: 'Ошибка получения всех событий' });
    }
});




app.post('/admins', async (req, res) => {
    const { adminId } = req.body;

    try {
        const adminsRef = db.collection('admins');
        const snapshot = await adminsRef.get();
        if (snapshot.docs.some(doc => doc.id === adminId)) {
            return res.status(400).json({ error: 'Этот админ уже существует!' });
        }

        await adminsRef.doc(adminId).set({});

        res.json({ message: 'Админ успешно создан!' });
    } catch (error) {
        console.error('Ошибка при добавлении админа:', error);
        res.status(500).json({ error: 'Ошибка при добавлении админа' });
    }
});


app.get('/get-admins', async (req, res) => {
    try {
        const adminsRef = db.collection('admins');
        const snapshot = await adminsRef.get();
        const admins = snapshot.docs.map(doc => doc.id);
        res.json({ admins });
    } catch (error) {
        console.error('Ошибка при получении администраторов:', error);
        res.status(500).json({ error: 'Ошибка при получении администраторов' });
    }
});

app.delete('/admins/:adminId', async (req, res) => {
    const adminId = req.params.adminId;

    try {
        await db.collection('admins').doc(adminId).delete();

        res.json({ message: 'Администратор успешно удален!' });
    } catch (error) {
        console.error('Ошибка при удалении администартора:', error);
        res.status(500).json({ error: 'Ошибка при удалении администратора' });
    }
});


app.post('/studios', async (req, res) => {
    const { studioName, chatId, description, timeZone } = req.body;

    try {
        const studiosRef = db.collection('studios');
        const snapshot = await studiosRef.get();

        if (snapshot.docs.some(doc => doc.id === studioName)) {
            return res.status(400).json({ error: 'Эта студия уже существует!' });
        }

        await studiosRef.doc(studioName).set({
            chatId: chatId,
            description: description,
            timeZone: timeZone,
        });

        res.json({ message: 'Студия успешно создана!' });
    } catch (error) {
        console.error('Ошибка при добавлении студии:', error);
        res.status(500).json({ error: 'Ошибка при добавлении студии' });
    }
});




app.get('/get-studios', async (req, res) => {
    try {
        const studiosRef = db.collection('studios');
        const snapshot = await studiosRef.get();
        const studios = snapshot.docs.map(doc => doc.id);
        res.json({ studios });
    } catch (error) {
        console.error('Ошибка при получении студий:', error);
        res.status(500).json({ error: 'Ошибка при получении студий' });
    }
});

app.get('/get-studios-with-chatId', async (req, res) => {
    try {
        const studiosRef = db.collection('studios');
        const snapshot = await studiosRef.get();

        const studios = {};
        snapshot.forEach(doc => {
            studios[doc.id] = doc.data().chatId;
        });

        res.json({ studios });
    } catch (error) {
        console.error('Ошибка при получении студий:', error);
        res.status(500).json({ error: 'Ошибка при получении студий' });
    }
});




app.delete('/studios/:studioName', async (req, res) => {
    const studioName = req.params.studioName;

    try {
        await db.collection('studios').doc(studioName).delete();

        res.json({ message: 'Студия успешно удалена!' });
    } catch (error) {
        console.error('Ошибка при удалении студии:', error);
        res.status(500).json({ error: 'Ошибка при удалении студии' });
    }
});





app.get('/get-admins-entry', async (req, res) => {
    try {
        const adminsRef = db.collection('admins');
        const snapshot = await adminsRef.get();
        const admins = snapshot.docs.map(doc => doc.id);
        res.json({ admins });
    } catch (error) {
        console.error('Ошибка при получении администраторов:', error);
        res.status(500).json({ error: 'Ошибка при получении администраторов' });
    }
});

app.get('/get-studios-user', async (req, res) => {
    try {
        const studiosRef = db.collection('studios');
        const snapshot = await studiosRef.get();
        const studios = snapshot.docs.map(doc => doc.id);
        res.json({ studios });
    } catch (error) {
        console.error('Ошибка при получении студий:', error);
        res.status(500).json({ error: 'Ошибка при получении студий' });
    }
});



// app.get('/', (req, res) => {
//   res.send('Сервер работает');
// });

// setInterval(async () => {
//   try {
//     const url = `https://YOUR_PROJECT_NAME.glitch.me/`;
//     await fetch(url);
//     console.log('Сервер не спит');
//   } catch (error) {
//     console.error('Ошибка при отправке запроса:', error);
//   }
// }, 60000);




app.post('/upload-tmc', upload.fields([
    { name: 'primaryFile', maxCount: 1 },
    { name: 'additionalFiles', maxCount: 10 }
]), async (req, res) => {
    const { tmcName, keywords, fileDescription, purchaseDate, studioName } = req.body;
    const repairDate = req.body.repairDate || '';
    const serviceDate = req.body.serviceDate || '';
    const primaryFile = req.files['primaryFile'] ? req.files['primaryFile'][0] : null;
    const additionalFiles = req.files['additionalFiles'] || [];
    let studios = [];
  
    const formattedKeywords = keywords
    .split(';')
    .map(word => word.trim().toLowerCase()) 
    .filter(word => word.length > 0)
    .join(';');

  
    console.log('Полученные данные:', req.body);
    console.log('Файлы:', req.files);

    if (Array.isArray(studioName)) {
        studios = studioName; 
    } else if (studioName) {
        studios.push(studioName);
    }


    if (req.body.selectAllStudios === 'true') {
        studios = await getAllStudios();
    } else if (studioName) {
        studios.push(studioName);
    }

    if (studios.length === 0 || !tmcName || !keywords) {
        return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    try {
        const fileUrls = [];
        const additionalFileUrls = [];

        if (primaryFile) {
            const originalFileName = decodeURIComponent(Buffer.from(primaryFile.originalname, 'latin1').toString('utf-8'));
            const fileName = `${studioName}/${tmcName}/primary_${Date.now()}_/!/${originalFileName}`;
            const fileUpload = bucket.file(fileName);

            await fileUpload.save(primaryFile.buffer, { contentType: primaryFile.mimetype });
            await fileUpload.makePublic();

            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            fileUrls.push(publicUrl);
        } else {
            fileUrls.push('');
        }

        for (const file of additionalFiles) {
            const originalAdditionalFileName = decodeURIComponent(Buffer.from(file.originalname, 'latin1').toString('utf-8'));
            const additionalFileName = `${studioName}/${tmcName}/additional_${Date.now()}_/!/${originalAdditionalFileName}`;
            const fileUpload = bucket.file(additionalFileName);

            await fileUpload.save(file.buffer, { contentType: file.mimetype });
            await fileUpload.makePublic();

            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${additionalFileName}`;
            additionalFileUrls.push(publicUrl);
        }

        for (const studio of studios) {
            if (!studio) continue;

            await db.collection('tmc').doc(studio).collection('tmcs').doc(tmcName).set({
                studioName: studio,
                tmcName,
                keywords: formattedKeywords, 
                fileDescription,
                purchaseDate,
                repairDate,
                serviceDate,
                fileUrls,
                additionalFileUrls,
            });
        }

        res.json({ message: 'ТМЦ успешно создан для всех выбранных студий!' });
    } catch (error) {
        console.error('Ошибка загрузки ТМЦ:', error);
        res.status(500).json({ error: 'Ошибка загрузки ТМЦ' });
    }
});


app.delete('/delete-tmc', async (req, res) => {
    const { studioName, tmcName } = req.body;

    if (!studioName || !tmcName) {
        return res.status(400).json({ error: 'Не указано название студии или ТМЦ' });
    }

    try {
        const tmcRef = db.collection('tmc').doc(studioName).collection('tmcs').doc(tmcName);
        const doc = await tmcRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'ТМЦ не найдена' });
        }

        await tmcRef.delete();
        return res.status(200).json({ message: 'ТМЦ удалена' });
    } catch (error) {
        console.error('Ошибка при удалении ТМЦ:', error);
        return res.status(500).json({ error: 'Ошибка удаления ТМЦ' });
    }
});


app.get('/search-tmc', async (req, res) => {
    const query = req.query.query ? req.query.query.toLowerCase().replace(/\s+/g, '') : null;
    const studioName = req.query.studioName;

    if (!studioName) {
        return res.status(400).json({ error: 'Необходимо указать студию' });
    }

    try {
        const tmcsRef = db.collection('tmc').doc(studioName).collection('tmcs');
        const snapshot = await tmcsRef.get();

        const results = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const formattedKeywords = data.keywords ? data.keywords.toLowerCase().replace(/\s+/g, '') : '';

            const additionalFileUrls = data.additionalFileUrls || [];

            if (!query || data.tmcName.toLowerCase().includes(query) || formattedKeywords.includes(query)) {
                results.push({
                    tmcName: data.tmcName,
                    description: data.fileDescription,
                    purchaseDate: data.purchaseDate,
                    repairDate: data.repairDate,
                    serviceDate: data.serviceDate,
                    fileUrls: data.fileUrls || [],
                    additionalFileUrls: additionalFileUrls
                });
            }
        });

        res.json(results);
    } catch (error) {
        console.error('Ошибка поиска ТМЦ:', error);
        res.status(500).json({ error: 'Ошибка поиска ТМЦ' });
    }
});



app.get('/get-tmc', async (req, res) => {
    const { studioName, tmcName } = req.query;

    try {
        const tmcDoc = await db.collection('tmc')
            .doc(studioName)
            .collection('tmcs')
            .doc(tmcName)
            .get();

        if (!tmcDoc.exists) {
            console.warn('ТМЦ не найдена:', studioName, tmcName);
            return res.status(404).json({ error: 'ТМЦ не найдена' });
        }

        const tmcData = tmcDoc.data();
        res.json({
            tmcName: tmcName,
            additionalFileUrls: tmcData.additionalFileUrls || [],
            fileDescription: tmcData.fileDescription || '',
            fileUrls: tmcData.fileUrls || [],
            keywords: (tmcData.keywords || '').replace(/;/g, ';'),
            purchaseDate: tmcData.purchaseDate || '',
            repairDate: tmcData.repairDate || '',
            serviceDate: tmcData.serviceDate || '',
        });
    } catch (error) {
        console.error('Ошибка получения данных ТМЦ:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});


app.post('/update-tmc', upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'additionalFiles', maxCount: 10 }
]), async (req, res) => {
    const { studioName, tmcName, fileDescription, keywords, purchaseDate, repairDate, serviceDate } = req.body;
    const file = req.files['file'] ? req.files['file'][0] : null;
    const additionalFiles = req.files['additionalFiles'] || [];
  
    console.log('Запрос на обновление TMC получен:', req.body);

    if (!studioName || !tmcName) {
        return res.status(400).json({ error: 'Studio name and TMC name are required.' });
    }

    try {
        const updateData = {
            fileDescription,
            keywords: keywords.replace(/;\s+/g, ';'),
            purchaseDate,
            repairDate: repairDate || '',
            serviceDate: serviceDate || '',
        };

        console.log('Запрос начался');
        const tmcDoc = await db.collection('tmc')
            .doc(studioName)
            .collection('tmcs')
            .doc(tmcName)
            .get();

        console.log('tmcDoc получен:', tmcDoc.exists ? 'Документ существует' : 'Документ не найден');

        if (!tmcDoc.exists) {
            console.log('TMC data не найдены');
            return res.status(404).json({ error: 'TMC data not found.' });
        }

        console.log('Обновление данных:', updateData);


        const existingData = tmcDoc.data();

        if (file) {
            const originalFileName = decodeURIComponent(Buffer.from(file.originalname, 'latin1').toString('utf-8'));
            const fileName = `${studioName}/${tmcName}/file_${Date.now()}_/!/${originalFileName}`;
            const newFile = bucket.file(fileName);
            await newFile.save(file.buffer, { contentType: file.mimetype });
            await newFile.makePublic();
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
            updateData.fileUrls = [publicUrl];
        } else {
            updateData.fileUrls = existingData.fileUrls || [];
        }

        if (additionalFiles.length > 0) {
            const additionalFileUrls = [];
            for (const additionalFile of additionalFiles) {
                const originalAdditionalFileName = decodeURIComponent(Buffer.from(additionalFile.originalname, 'latin1').toString('utf-8'));
                const additionalFileName = `${studioName}/${tmcName}/additional_${Date.now()}_/!/${originalAdditionalFileName}`;
                const newAdditionalFile = bucket.file(additionalFileName);
                await newAdditionalFile.save(additionalFile.buffer, { contentType: additionalFile.mimetype });
                await newAdditionalFile.makePublic();
                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${additionalFileName}`;
                additionalFileUrls.push(publicUrl);
            }
            updateData.additionalFileUrls = additionalFileUrls;
        } else {
            updateData.additionalFileUrls = existingData.additionalFileUrls || [];
        }

        await db.collection('tmc')
            .doc(studioName)
            .collection('tmcs')
            .doc(tmcName)
            .set(updateData, { merge: true });

        res.json({ message: 'Данные ТМЦ успешно обновлены' });
    } catch (error) {
        console.error('Ошибка обновления ТМЦ:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});










// app.post('/upload-contact', async (req, res) => {
//     const { StudioName, name, photo, description, phone } = req.body;

//     if ( !StudioName|| !name || !photo || !description || !phone) {
//         return res.status(400).json({ error: 'Не все поля заполнены' });
//     }

//     try {
//         const contactsRef = db.collection('contacts').doc(StudioName);
//         await contactsRef.add({ name, photo, description, phone });
//         res.json({ message: 'Контакт успешно создан!' });
//     } catch (error) {
//         console.error('Ошибка при создании контакта:', error);
//         res.status(500).json({ error: 'Ошибка при создании контакта' });
//     }
// });


app.post('/upload-contacts', upload.single('file'), async (req, res) => {
    const { contactName, description, phone, keywords, studioName, selectAllStudios } = req.body;
    const file = req.file; // Получаем файл

    if (!contactName || !description || !phone) {
        return res.status(400).json({ error: 'Не все обязательные поля заполнены' });
    }

    try {
        const studios = selectAllStudios ? await getAllStudios() : [studioName];

        // Обработка загрузки файла, если он есть
        let fileUrl = '';
        if (file) {
            const originalFileName = decodeURIComponent(Buffer.from(file.originalname, 'latin1').toString('utf-8'));
            const fileName = `contacts/${contactName}/${Date.now()}_/!/${originalFileName}`;
            const fileUpload = bucket.file(fileName);

            await fileUpload.save(file.buffer, { contentType: file.mimetype });
            await fileUpload.makePublic();

            fileUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        }

        for (const studio of studios) {
            if (!studio) continue;

            await db.collection('contacts').doc(studio).collection('contactEntries').doc(contactName).set({
                contactName,
                description,
                phone,
                keywords: keywords.replace(/\s+/g, '').toLowerCase(),
                fileUrl,
            });
        }

        res.json({ message: 'Контакт успешно создан' });
    } catch (error) {
        console.error('Ошибка при создании контакта:', error);
        res.status(500).json({ error: 'Ошибка при создании контакта' });
    }
});


app.delete('/delete-contact', async (req, res) => {
    const { studioName, contactName } = req.body;

    if (!studioName || !contactName) {
        return res.status(400).json({ error: 'Не указано название студии или контакта' });
    }

    try {
        const tmcRef = db.collection('contacts').doc(studioName).collection('contactEntries').doc(contactName);
        const doc = await tmcRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Контакт не найден' });
        }

        await tmcRef.delete();
        return res.status(200).json({ message: 'Контакт удален' });
    } catch (error) {
        console.error('Ошибка при удалении Контакта:', error);
        return res.status(500).json({ error: 'Ошибка удаления контакта' });
    }
});



app.get('/contacts', async (req, res) => {
    const studioName = req.query.studioName;

    if (!studioName) {
        return res.status(400).json({ error: 'Не указано название студии' });
    }

    try {
        const contactsRef = db.collection('contacts').doc(studioName).collection('contactEntries');
        const snapshot = await contactsRef.get();

        const contacts = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            contacts.push({
                contactName: data.contactName,
                description: data.description,
                phone: data.phone,
                fileUrl: data.fileUrl || null,
                keywords: data.keywords || '' 
            });
        });

        res.json(contacts);
    } catch (error) {
        console.error('Ошибка получения контактов:', error);
        res.status(500).json({ error: 'Ошибка получения контактов' });
    }
});



app.get('/get-contact', async (req, res) => {
    const { studioName, contactName } = req.query;

    try {
        const contactDoc = await db.collection('contacts')
            .doc(studioName)
            .collection('contactEntries')
            .doc(contactName)
            .get();

        if (!contactDoc.exists) {
            console.warn('Контакт не найден:', studioName, contactName);
            return res.status(404).json({ error: 'Контакт не найден' });
        }

        const contactData = contactDoc.data();
        res.json({
            contactName: contactName,
            description: contactData.description || '',
            fileUrl: contactData.fileUrl || '',
            keywords: (contactData.keywords || '').replace(/;/g, ';'),
            phone: contactData.phone || '',
        });
    } catch (error) {
        console.error('Ошибка получения данных контакта:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});

app.post('/update-contact', upload.single('contactImage'), async (req, res) => {
    const { studioName, contactName, description, keywords, phone } = req.body;
    const contactImage = req.file ? req.file : null;

    console.log('Запрос на обновление контакта получен:', req.body);

    if (!studioName || !contactName) {
        return res.status(400).json({ error: 'Имя студии и контактное имя обязательны.' });
    }

    try {
        const updateData = {
            description,
            keywords: keywords ? keywords.replace(/;\s+/g, ';').toLowerCase() : '',
            phone,
        };

        const contactDoc = await db.collection('contacts')
            .doc(studioName)
            .collection('contactEntries')
            .doc(contactName)
            .get();

        if (!contactDoc.exists) {
            return res.status(404).json({ error: 'Контакт не найден.' });
        }

        const existingData = contactDoc.data();

        if (contactImage) {
            const originalImageName = decodeURIComponent(Buffer.from(contactImage.originalname, 'latin1').toString('utf-8'));
            const imageFileName = `${studioName}/${contactName}/image_${Date.now()}_/!/${originalImageName}`;
            const newImageFile = bucket.file(imageFileName);
            await newImageFile.save(contactImage.buffer, { contentType: contactImage.mimetype });
            await newImageFile.makePublic();
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${imageFileName}`;
            updateData.fileUrl = publicUrl;
        } else if (contactImage === '') {
            updateData.fileUrl = existingData.fileUrl;
        }

        await db.collection('contacts')
            .doc(studioName)
            .collection('contactEntries')
            .doc(contactName)
            .set(updateData, { merge: true });

        res.json({ message: 'Контакт успешно обновлен!' });
    } catch (error) {
        console.error('Ошибка обновления контакта:', error);
        res.status(500).json({ error: 'Ошибка на сервере' });
    }
});



app.get('/get-studio-description', async (req, res) => {
    const studioName = req.query.studio;

    if (!studioName) {
        return res.status(400).json({ error: "Studio name is required." });
    }

    try {
        const studioRef = db.collection('studios').doc(studioName);
        const doc = await studioRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Studio not found." });
        }

        const studioData = doc.data();
        res.json({ description: studioData.description || "Описание недоступно" });
    } catch (error) {
        console.error("Error fetching studio description:", error);
        res.status(500).json({ error: "Internal server error." });
    }
});






app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
