from html import escape

from flask import Flask, render_template, request

import chandelier

app = Flask(__name__)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/button-action", methods=['GET', 'POST'])
def button_action():
    button_val = request.form.get('btn')
    match button_val:
        case "start":
            chandelier.main()
            return "<p>Congrats, the chandelier should have started</p>"
        case "stop":
            return "<h1>Things have been set into motion that can't be stopped</h1>"
        case _:
            return f"<p>Somehow you clicked a button that doesn't match the expected values: {button_val}</p>"