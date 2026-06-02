import os, asyncio, smtplib
from email.mime.text import MIMEText
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_KEY')
GMAIL_USER = "vanshika.catprep@gmail.com"
GMAIL_PASS = os.environ.get('GMAIL_PASS')

@app.route('/health')
def health():
    return jsonify({'ok': True})

@app.route('/claude', methods=['POST'])
def claude():
    import anthropic
    data = request.json
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    msg = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        system=data.get('system',''),
        messages=data.get('messages',[])
    )
    return jsonify({'text': msg.content[0].text})

@app.route('/send-email', methods=['POST'])
def send_email():
    data = request.json
    msg = MIMEText(data['body'])
    msg['Subject'] = data['subject']
    msg['From'] = GMAIL_USER
    msg['To'] = data['to']
    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as s:
            s.login(GMAIL_USER, GMAIL_PASS)
            s.send_message(msg)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

@app.route('/apply', methods=['POST'])
def apply_job():
    data = request.json
    try:
        from browser_use import Agent
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model='claude-sonnet-4-20250514', api_key=ANTHROPIC_KEY)
        agent = Agent(
            task=f"""
            Go to {data['url']}.
            Apply for the job. Use:
            Name: Vanshika Gandhi
            Email: vanshika.catprep@gmail.com
            Phone: +91 8766938952
            LinkedIn: linkedin.com/in/vanshikagandhi11
            College: IIM Bodh Gaya, IPM 2023-2028, CGPA 8.35
            If account creation needed, use vanshika.catprep@gmail.com.
            Pre-filled answers: {data.get('answers', {})}
            After done, return success or failure with any confirmation number.
            """,
            llm=llm
        )
        result = asyncio.run(agent.run())
        return jsonify({'ok': True, 'result': str(result)})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
