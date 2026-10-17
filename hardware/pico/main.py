# Grid Status Box (CONTROL ROOM: URI). Runs on a Raspberry Pi Pico 2 with MicroPython.
# USB serial, one word per line.
#   Pico -> laptop: PAUSE, SPEED, CONFIRM
#   Laptop -> Pico: GREEN, YELLOW, RED (light only that LED), BEEP (2 kHz, 100 ms), TONE (1 kHz, 1 s)
import select
import sys
import time
from machine import PWM, Pin

DEBOUNCE_MS = 50

# Buttons: GPIO to one leg, the diagonally opposite leg to GND. Internal pull-ups, pressed = 0.
buttons = [Pin(2, Pin.IN, Pin.PULL_UP), Pin(3, Pin.IN, Pin.PULL_UP), Pin(4, Pin.IN, Pin.PULL_UP)]
words = ["PAUSE", "SPEED", "CONFIRM"]

# LEDs: GPIO -> 220 ohm -> anode, cathode to GND.
leds = {"GREEN": Pin(10, Pin.OUT), "YELLOW": Pin(11, Pin.OUT), "RED": Pin(12, Pin.OUT)}

# Passive piezo buzzer on PWM, silent until asked.
buzzer = PWM(Pin(15))
buzzer.duty_u16(0)

# Power-up: flash all LEDs three times.
for _ in range(3):
    for led in leds.values():
        led.on()
    time.sleep_ms(150)
    for led in leds.values():
        led.off()
    time.sleep_ms(150)

raw = [1, 1, 1]          # last reading of each button
stable = [1, 1, 1]       # debounced level of each button
changed_at = [0, 0, 0]   # when each reading last changed
buzzing = False
buzz_until = 0
line = ""

poll = select.poll()
poll.register(sys.stdin, select.POLLIN)

while True:
    now = time.ticks_ms()

    # Buttons: a press counts once the level has held for 50 ms.
    for i in range(3):
        level = buttons[i].value()
        if level != raw[i]:
            raw[i] = level
            changed_at[i] = now
        elif level != stable[i] and time.ticks_diff(now, changed_at[i]) >= DEBOUNCE_MS:
            stable[i] = level
            if level == 0:
                print(words[i])

    # Incoming words, without blocking.
    while poll.poll(0):
        ch = sys.stdin.read(1)
        if ch != "\n" and ch != "\r":
            line += ch
            if len(line) > 16:   # not one of our words; drop it
                line = ""
            continue
        word = line.strip().upper()
        line = ""
        if word in leds:
            for name in leds:
                leds[name].value(name == word)
        elif word == "BEEP":
            buzzer.freq(2000)
            buzzer.duty_u16(32768)
            buzzing = True
            buzz_until = time.ticks_add(now, 100)
        elif word == "TONE":
            buzzer.freq(1000)
            buzzer.duty_u16(32768)
            buzzing = True
            buzz_until = time.ticks_add(now, 1000)

    # Buzzer off when its time is up.
    if buzzing and time.ticks_diff(now, buzz_until) >= 0:
        buzzer.duty_u16(0)
        buzzing = False

    time.sleep_ms(2)
