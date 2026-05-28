#include <PID_v1.h>
#include <Wire.h>
#include <EEPROM.h>
#include <math.h>
#include <CRC16.h>
#include <CRC.h>

// TODO:
// Add logic to Pi to use case 3, toggle_light. Indicate that a bulb is switched off by making it glow dark blue. Long press a blue bulb to turn it back on.
// Bulb occasionally gets stuck at a peak and can't move in the other direction so it errors out - not seen often in wave motion

#define LIMIT_PIN 4
#define SDA_PIN A4
#define MTR_PWM_PIN 9
#define SCL_PIN A5
#define MTR_DIR_PIN 8
#define LIGHT_PWM_PIN 10
#define ENC1_PIN 3  // Interrupt pin on Nano
#define ENC0_PIN 2

#define DEPLOY 1  // Motor direction
#define STOW 0
// the triggered limit switch reads HIGH

#define SAMPLE_PERIOD 10       // milliseconds
#define WAIT_FOR_TRIGGER 1000  // milliseconds

float max_ips = 1.2;
#define MIN_IPS 0.008  // stops moving when very close. This is about half a turn of the motor shaft
float min_ips = MIN_IPS;
#define MAX_SPEED 255  // max analog_write value

#define TOP_CUSTOM 0x0300  // determines pwm frequency. Divide 16 MHz by this number

// Wire winds up according to archimedian spiral equation
// r = 0.0927/2pi * theta
// starting at r = 1.91 (measured) or theta  = 129.459, so the path length equation in ticks_to_inches starts there
// If the spiral were to go from the center to the start, it would have total length 123.678
// these values will need to be recalculated for a different length of wire being wound or if the packing factor changes, using a newton's method to determine the r constant and the theta
#define PACKING_RATE 0.0927                          // inches per wrap. approximately equal to wire diameter
#define WIRE_MAX_LENGTH 102                          // inches
#define TOTAL_TURNS 12                               // reference count
#define SPIRAL_START_ANGLE 129.459                   // radians to reach a spiral wrap of r=1.91
#define STARTING_SPIRAL_LENGTH 123.678               // inches
const float ticks_to_radians = 2 * M_PI / 200 / 60;  // 2pi radians in a revolution, 100 line encoder double counted, 60 tooth worm gear
long max_encoder = 100;

const bool verbose = false;


// Communicated values
uint8_t address = 0;
uint8_t payload = 0;
uint8_t special = 0;
uint8_t brightness = 100;
bool LED_on = true;
bool currently_zeroing = false;
bool disable_all = false;
bool hit_max_speed_warning = false;

// PID values
double speed_goal = 0, real_speed, encoder_val = 0, analog_write_val, last_real_length, setpoint = 0.2;  // positive is in deploy direction
// default position is slightly under the stowed position
double Kp = 20, Ki = 400, Kd = 0, Kp_pos = 3;
PID speedPID(&real_speed, &analog_write_val, &speed_goal, Kp, Ki, Kd, DIRECT);

long start_time = millis();


void setup() {
  if (verbose) {
    Serial.begin(9600);
    Serial.println("Hello World");
  }

  EEPROM.get(0, brightness);

  TCCR1A = B10100010;                       // COM1A1=1 (pin9), COM1B1=1 (pin10), WGM11=1 — fast PWM, non-inverting, TOP=ICR1
  TCCR1B = TCCR1B & B11100000 | B00011001;  // No prescaling
  ICR1 = TOP_CUSTOM;                        //16 MHz / 20 kHz = 800 counts, rounded down to make sure it's far away from 20 kHz
  pwm_light(brightness);

  pinMode(LIMIT_PIN, INPUT_PULLUP);
  pinMode(MTR_PWM_PIN, OUTPUT);
  pinMode(MTR_DIR_PIN, OUTPUT);
  run_motor(0);
  pinMode(LIGHT_PWM_PIN, OUTPUT);
  pinMode(ENC0_PIN, INPUT);
  pinMode(ENC1_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENC1_PIN), encoderISR, CHANGE);

  if (verbose) Serial.println("Pin assignments complete");

  speedPID.SetOutputLimits(-MAX_SPEED, MAX_SPEED);
  speedPID.SetSampleTime(SAMPLE_PERIOD);
  speedPID.SetMode(AUTOMATIC);

  if (verbose) Serial.println("PID setup complete");

  read_board_address();
  Wire.begin(address);            // join i2c
  Wire.onReceive(receive_event);  // register events
  Wire.onRequest(request_event);

  if (verbose) Serial.println("i2c join complete");

  delay(10);
}

void loop() {
  if (special)  // run special code (such as save position) if HEAD commands it
    Special();
  if (digitalRead(LIMIT_PIN))
    limit_switch_interrupt();
  else if (encoder_val > max_encoder) {  // only allow running in reverse if bulb is overextended
    speed_goal = constrain((setpoint - ticks_to_inches(encoder_val)) * Kp_pos, -max_ips, 0);
    run_at_speed_goal();
  } else {
    speed_goal = constrain((setpoint - ticks_to_inches(encoder_val)) * Kp_pos, -max_ips, max_ips);
    run_at_speed_goal();
  }
}

void encoderISR() {
  if (digitalRead(ENC0_PIN) == digitalRead(ENC1_PIN))
    encoder_val++;
  else
    encoder_val--;
}

void receive_event(uint8_t howMany) {
  if (Wire.available()) {
    uint8_t data[5];
    data[0] = address;
    for (int i = 1; i < 5; i++)
      data[i] = Wire.read();
    uint8_t checksum_high = Wire.read();
    uint8_t checksum_low = Wire.read();

    while (Wire.available())  // flush everything else
      Wire.read();
    if (((checksum_high << 8) | checksum_low) != calcCRC16((uint8_t *)data, 5, 0x1021))  // polynome matches python's library default
      return;
    special = data[3];  // says what the next byte means
    payload = data[4];  // can be brightness, for example
    setpoint = double(data[1]) + double(data[2]) / 256;
  }
}

void request_event() {  // dump all info when anything is requested
  uint8_t int_position = last_real_length;
  uint8_t frac_position = (last_real_length - int_position) * 256;
  uint8_t packed_speed = real_speed * 32;  // 8 ips is around the max speed. Leaves 5 bits for fractional speed
  uint8_t packed_data = LED_on | currently_zeroing << 1 | disable_all << 2 | hit_max_speed_warning << 3;
  Wire.write(int_position);
  Wire.write(frac_position);
  Wire.write(brightness);
  Wire.write(packed_speed);
  Wire.write(packed_data);
  uint8_t data[6] = { address, int_position, frac_position, brightness, packed_speed, packed_data };
  uint16_t checksum = calcCRC16((uint8_t *)data, 6, 0x1021);  // polynome matches the pi side
  Wire.write((uint8_t)(checksum >> 8));
  Wire.write((uint8_t)checksum);
  disable_all = false;            // one-time toggle. Sending disable_all again starts the chandelier back up
  hit_max_speed_warning = false;  // only checks per request_event
}

void limit_switch_interrupt() {
  run_motor(0);
  uint32_t start_time = millis();
  bool limit_state = HIGH;
  uint8_t down_count = 1;
  while (millis() - start_time < WAIT_FOR_TRIGGER) {
    if (digitalRead(LIMIT_PIN) != limit_state) {
      limit_state = !limit_state;
      down_count += limit_state;  //increments down_count every other trigger (only on trigger, not release)
      start_time = millis();
    }
    long temp_start_time = millis();
    while (millis() - temp_start_time < 5)
      ;  // debounce
  }
  if (limit_state == 1) {
    zero_procedure(-1);
    return;
  } else if (down_count == 1)
    toggle_light();
  else if (down_count >= 2)
    toggle_all_lights();
  return;       // don't want to leave the light on
  delay(1100);  // gets polled every 1 second, so need to wait long enough to turn off
}

void toggle_light() {
  if (verbose)
    Serial.println("Toggling light");
  LED_on = !LED_on;
  pwm_light(LED_on * brightness);
}

void toggle_all_lights() {
  if (verbose)
    Serial.println("Disabling all lights");
  disable_all = true;
}

void zero_procedure(double zero_rate) {
  if (verbose)
    Serial.println("Zeroing");
  currently_zeroing = true;
  speed_goal = 0.5;
  while (digitalRead(LIMIT_PIN) == HIGH)  // run until untriggered
    run_at_speed_goal();
  speed_goal = zero_rate;
  delay(10);
  while (digitalRead(LIMIT_PIN) == LOW)  // quickly retract until triggered
    run_at_speed_goal();
  encoder_val = 0;
  last_real_length = 0;
  speed_goal = 0.3;
  delay(10);
  while (digitalRead(LIMIT_PIN) == HIGH)  // release switch so we don't zero again
    run_at_speed_goal();
  long start_time = millis();
  while (millis() - start_time < 100)  // go .1 seconds longer so the bulb doesn't re-trigger
    run_at_speed_goal();
  currently_zeroing = false;
  if (verbose)
    Serial.println("Done zeroing");
}

void run_motor(int16_t speed) {
  if (speed > 0)
    digitalWrite(MTR_DIR_PIN, DEPLOY);
  else
    digitalWrite(MTR_DIR_PIN, STOW);
  if (abs(speed) > 255)
    hit_max_speed_warning = true;
  pwm_motor(255 - min(abs(speed), MAX_SPEED));  // subtract from 255 since 255 is stationary and 0 is max speed
}

double ticks_to_inches(double ticks) {
  double theta = ticks * ticks_to_radians;
  theta = SPIRAL_START_ANGLE - theta;
  return STARTING_SPIRAL_LENGTH - (PACKING_RATE / (4 * M_PI) * (theta * sqrt(1 + theta * theta) + log(theta + sqrt(1 + theta * theta))));  // equation for length of archimedian spiral
}

double inches_to_ticks(double inches) {  // Newton's method ticks_to_inches because the function can't easily be inverted
                                         // Inefficient is fine because it only happens occasionally
  double error = 1;
  double guess = 120000;
  int counter = 0;
  while (abs(error) > 0.01) {
    error = inches - ticks_to_inches(guess);
    guess += error * 1000;
    counter += 1;
    if (counter >= 100) {
      Serial.println("inches_to_ticks diverged");
      exit(0);
    }
  }
  return round(guess);
}

void run_at_speed_goal() {
  if (abs(speed_goal) < min_ips) {
    min_ips = MIN_IPS + 0.003;
    run_motor(0);
  } else if (speedPID.Compute()) {
    min_ips = MIN_IPS;
    run_motor(analog_write_val);
    double real_length = ticks_to_inches(encoder_val);
    real_speed = (real_length - last_real_length) * 1000 / (millis() - start_time);
    if (verbose) {
      //Serial.print("Real speed: "); Serial.println(real_speed);
    }
    last_real_length = real_length;
    start_time = millis();
  }
}

void read_board_address() {
#define ADDR_PIN_COUNT 7
  const uint8_t addr_pins[ADDR_PIN_COUNT] = { 6, 11, 12, A0, A1, A2, A3 };  // Do not use pin 13 for input. Add new pin when next board arrives

  address = 0;
  for (int i = 0; i < ADDR_PIN_COUNT; i++) {
    pinMode(addr_pins[i], INPUT_PULLUP);  // reads solder bridges on board
    delay(1);
    address *= 2;
    address += !digitalRead(addr_pins[i]);  // connected bridge is 1 which reads as LOW
    Serial.println(digitalRead(addr_pins[i]));
  }
  address += 0x08;  // 8 is first unreserved address. Last few addresses will not work because of this
  if (verbose) {
    Serial.print("address: ");
    Serial.println(address);
  }
}

void pwm_motor(uint8_t val) {
  OCR1A = map(val, 0, 255, 0, TOP_CUSTOM);
}

void pwm_light(uint8_t val) {
  if (val == 0)
    OCR1B = 0;
  else if (val < 38) // I love me some magic numberrs
    OCR1B = val + 7;
  else
    OCR1B = map((long)val * val, 37*37, 255L * 255L, 45, TOP_CUSTOM);  // quadratic scaling to enhance low end, but only kicks in once the map becomes approximately linear
}

void Special() {
  switch (special) {
    case 1:  // brightness
      brightness = payload;
      pwm_light(LED_on * brightness);
      break;
    case 2:  // tell position
      encoder_val = inches_to_ticks(setpoint);
      last_real_length = setpoint;
      break;
    case 3:
      toggle_light();
      break;
    case 4: // set starting brightness
      EEPROM.put(0, payload);
      break;
    // case 5:
    //   Ki = payload * 10;
    //   speedPID.SetTunings(Kp, Ki, Kd);
    //   break;
    // case 6:
    //   Kd = float(payload) / 10;
    //   speedPID.SetTunings(Kp, Ki, Kd);
    //   break;
    case 7:
      Kp_pos = float(payload) / 10;
      break;
    case 8:
      max_ips = float(payload) / 10;
      break;
    case 9:
      zero_procedure(-1.0);
      break;
    case 10:
      max_encoder = inches_to_ticks(min(payload, WIRE_MAX_LENGTH));
      break;
  }
  special = 0;
}