from flask import Flask, render_template, request
import asyncio
import chandelier

app = Flask(__name__)
chandelier_server = chandelier.ChandelierServer()
loop = asyncio.new_event_loop()
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/button-action", methods=['GET', 'POST'])
def button_action():
    button_val = request.form.get('btn')
    match button_val:
        case "start":
            loop.create_task(chandelier_server.start_chandelier())
            return "<p>Congrats, the chandelier should have started</p>"
        case "stop":
            loop.create_task(chandelier_server.stop_chandelier())
            return "<h1>Chandelier should stop moving</h1>"
        case "set":
            # tbd
            return "<h1>Chandelier should move to the input positions</h1>"
        case "cycle":
            # tbd
            return "<h1>Each bulb should cycle through all positons in sequence</h1>"
        case _:
            return f"<p>Somehow you clicked a button that doesn't match the expected values: {button_val}</p>"