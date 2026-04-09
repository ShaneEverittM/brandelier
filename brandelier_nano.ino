#include <PID_v1.h>
#include <Wire.h>
#include <EEPROM.h>
#include <math.h>
#include <CRC16.h>
#include <CRC.h>

// TODO:
// Implement dip switch
// Implement compression spring
// Test inch to tick conversion
// Jolts on startup - done but not tested
// Option to set max length - done but not tested

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

#define SCALE 5  // position scale factor is 2^5 or 32

#define ADDR_PIN_COUNT 6
uint8_t addr_pins[ADDR_PIN_COUNT] = { 11, 12, A0, A1, A2, A3 };  // Do not use pin 13 for input. Removed from program but not board. Next board version should have 3rd highest bit rerouted
float max_ips = 1.2;
#define MIN_IPS 0.008     // stops moving when very close. This is about half a turn of the motor shaft
float min_ips = MIN_IPS;  
#define MAX_SPEED 255  // max analog_write value


// Wire winds up according to archimedian spiral equation
// r = 0.1013/2pi * theta
// starting at r = 2 or theta  = 128.20, so the path length equation in ticks_to_inches starts there
// If the spiral were to go from the center to the start, it would have length 17.54,
// then add the length of the wire, 115" (120 with 5" used for bulb and soldering) to get 132.54
// these values will need to be recalculated for a different length of wire being wound or if the packing factor changes, using a newton's method to determine the r constant and the theta
#define PACKING_RATE 0.1013 // inches per wrap. approximately equal to wire diameter
#define WIRE_MAX_LENGTH 115 // inches
#define TOTAL_TURNS 13 // count
#define SPIRAL_START_ANGLE 128.20 // radians to reach a spiral wrap of r=2
#define STARTING_SPIRAL_LENGTH 132.54 // inches
const long in_to_tick = 400 * 60 / 4 / M_PI;  // depricated
const float ticks_to_radians = 2 * M_PI / 200 / 60; // 2pi radians in a revolution, 100 line encoder double counted, 60 tooth worm gear
long max_encoder;


bool LED_on = true;
const bool verbose = true;

uint8_t address = 0;
uint8_t payload = 0;
uint8_t special = 0;
uint8_t brightness = 25;
bool currently_zeroing = false;

double speed_goal = 0, real_speed, encoder_val, analog_write_val, last_real_length, setpoint = 0.2;  // positive is in deploy direction
// default position is slightly under the stowed position
double Kp = 20, Ki = 400, Kd = 0, Kp_pos = 3;
PID speedPID(&real_speed, &analog_write_val, &speed_goal, Kp, Ki, Kd, DIRECT);

long start_time = millis();


void setup() {
  if (verbose) {
    Serial.begin(9600);
    Serial.println("Hello World");
  }
  max_encoder = inches_to_ticks(WIRE_MAX_LENGTH);  // max length
  if (verbose) {
    Serial.print("tick length: ");
    Serial.println(max_encoder);
  }
  
  EEPROM.get(0, encoder_val);  // encoder value is the only thing stored in EEPROM for now
  last_real_length = ticks_to_inches(encoder_val);
  if (isnan(encoder_val)) {
    encoder_val = 0;
    EEPROM.put(0, encoder_val);
  }

  TCCR1B = TCCR1B & B11111000 | B00000001;  // for PWM frequency of 31372.55 Hz above the range of human hearing

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

  pinMode(LIMIT_PIN, INPUT_PULLUP);
  pinMode(MTR_PWM_PIN, OUTPUT);
  pinMode(MTR_DIR_PIN, OUTPUT);
  run_motor(0);
  pinMode(LIGHT_PWM_PIN, OUTPUT);
  analogWrite(LIGHT_PWM_PIN, 25);
  pinMode(ENC0_PIN, INPUT);
  pinMode(ENC1_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENC1_PIN), encoderISR, CHANGE);

  if (verbose) Serial.println("Pin assignments complete");

  speedPID.SetOutputLimits(-MAX_SPEED, MAX_SPEED);
  speedPID.SetSampleTime(SAMPLE_PERIOD);
  speedPID.SetMode(AUTOMATIC);

  if (verbose) Serial.println("PID setup complete");

  Wire.begin(address);           // join i2c
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
  else if (encoder_val > max_encoder) { // only allow running in reverse if bulb is overextended
    analogWrite(LIGHT_PWM_PIN, 0);
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

    while (Wire.available())          // flush everything else
      Wire.read();
    if (((checksum_high << 8) | checksum_low) != calcCRC16((uint8_t *)data, 5, 0x1021)) // polynome matches python's library default
      return;
    special = data[3];            // says what the next byte means
    payload = data[4];            // can be brightness, for example
    setpoint = double(data[1]) + double(data[2]) / 256;
  }
}

void request_event() { // dump all info when anything is requested
  uint8_t int_position = last_real_length;
  uint8_t frac_position = (last_real_length - int_position)*256;
  Wire.write(int_position);
  Wire.write(frac_position);
  Wire.write(uint8_t(LED_on));
  Wire.write(uint8_t(currently_zeroing));
  uint8_t data[5] = {address, int_position, frac_position, LED_on, currently_zeroing};
  uint16_t checksum = calcCRC16((uint8_t *)data, 5, 0x1021); // polynome matches python's library default
  Wire.write((uint8_t)(checksum >> 8));
  Wire.write((uint8_t)checksum);
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
    zero_procedure(-0.5);
    return;
  } else if (down_count == 1)
    toggle_light();
  else if (down_count >= 2)
    stop_moving();
  delay(1000);
}

void toggle_light() {
  LED_on = !LED_on;
  analogWrite(LIGHT_PWM_PIN, LED_on * brightness);
}

void zero_procedure(double zero_rate) {
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
}

void stop_moving() {
  speed_goal = 0;
  while (digitalRead(LIMIT_PIN) == LOW)
    run_at_speed_goal();
  delay(1000);
}

void run_motor(int16_t speed) {
  if (speed > 0)
    digitalWrite(MTR_DIR_PIN, DEPLOY);
  else
    digitalWrite(MTR_DIR_PIN, STOW);
  analogWrite(MTR_PWM_PIN, 255 - min(abs(speed), MAX_SPEED));  // subtract from 255 since 255 is stationary and 0 is max speed
}

double ticks_to_inches(double ticks) {
  double theta = ticks * ticks_to_radians;
  theta = SPIRAL_START_ANGLE - theta;
  return STARTING_SPIRAL_LENGTH - (PACKING_RATE / (4 * M_PI) * (theta * sqrt(1 + theta * theta) + log(theta + sqrt(1 + theta * theta)))); // equation for length of archimedian spiral
}

double inches_to_ticks(double inches) {  // Newton's method ticks_to_inches because the function can't easily be inverted
                                         // Inefficient is fine because it only happens occasionally
  double error = 1;
  double guess = 120000;
  int counter = 0;
  while (abs(error) > 0.1) {
    error = inches - ticks_to_inches(guess);
    guess += error*1000;
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

void Special() {
  switch (special){
    case 1:  // brightness
      brightness = payload;
      analogWrite(LIGHT_PWM_PIN, LED_on * brightness);
      break;
    case 2:  // save encoder position
      run_motor(0);
      delay(500);
      EEPROM.put(0, encoder_val);
      delay(4500);
      break;
    // case 3:  // change max speed - obsolete since it can be gated by max_ips
    //   MAX_SPEED = payload / 10;
    //   speedPID.SetOutputLimits(-MAX_SPEED, MAX_SPEED);
    //   break;
    // case 4:
    //   Kp = payload;
    //   speedPID.SetTunings(Kp, Ki, Kd);
    //   break;
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