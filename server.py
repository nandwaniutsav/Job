import os
import smtplib
from email.mime.text import MIMEText
from flask import Flask, request, jsonify
from flask_cors import CORS
import anthropic

app = Flask(__name__)
CORS(app)

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_KEY')
GMAIL_USER = "vanshikagandhi.marketing@gmail.com"
GMAIL_PASS = os.environ.get('GMAIL_PASS')

@app.route('/health')
def health():
    return jsonify({'ok': True})

@app.route('/claude', methods=['POST'])
def claude():
    try:
        data = request.json
        client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
        msg = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1500,
            system=data.get('system', ''),
            messages=data.get('messages', [])
        )
        return jsonify({'text': msg.content[0].text})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/send-email', methods=['POST'])
def send_email():
    try:
        data = request.json
        msg = MIMEText(data['body'])
        msg['Subject'] = data['subject']
        msg['From'] = GMAIL_USER
        msg['To'] = data['to']
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as s:
            s.login(GMAIL_USER, GMAIL_PASS)
            s.send_message(msg)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
