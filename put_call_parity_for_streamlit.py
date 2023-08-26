# -*- coding: utf-8 -*-
"""
Created on Fri Aug 25 22:56:04 2023

@author: kpa32
"""

import streamlit as st
import random

def get_random_value(min_val, max_val, decimals=0):
    return round(random.uniform(min_val, max_val), decimals)

def play_game():
    options = ['spot', 'strike', 'carry', 'call', 'put']
    missing_variable = random.choice(options)
    
    spot = get_random_value(10, 110, 2)
    strike = get_random_value(.9*spot, 1.1 * spot, 0)
    carry = get_random_value(-0.05 * spot, 0.05 * spot, 2)
    
    if spot > strike:
        put = get_random_value(0, .1 * strike, 2)
    elif spot < strike:   
        put = round(get_random_value(0, .1 * strike, 2) + (strike - spot), 2)
    
    call = max(0, round(spot - strike + put + carry, 2))

    st.write(f"Questions Remaining: {st.session_state.num_games - st.session_state.games_played}")

    if missing_variable != 'spot':
        st.write(f"Spot: {spot}")
    if missing_variable != 'strike':
        st.write(f"Strike: {strike}")
    if missing_variable != 'carry':
        st.write(f"Carry: {carry}")
    if missing_variable != 'call':
        st.write(f"Call: {call}")
    if missing_variable != 'put':
        st.write(f"Put: {put}")

    user_input = st.text_input(f"Enter the value for {missing_variable}:")
    
    if user_input:
        user_value = float(user_input)
        correct_values = {
            'spot': spot,
            'strike': strike,
            'carry': carry,
            'call': call,
            'put': put
        }

        if correct_values[missing_variable] == user_value:
            st.session_state.correct += 1
            st.success("Correct!")
            st.session_state.games_played += 1
        else:
            st.error("Incorrect! Try again.")

        if st.session_state.games_played == st.session_state.num_games:
            accuracy = (st.session_state.correct / st.session_state.num_games) * 100
            st.write(f"Game Over! Your accuracy is: {accuracy:.2f}%")
            if 'restart_button' not in st.session_state:
                st.session_state.restart_button = st.button("Play Again?")
                if st.session_state.restart_button:
                    st.session_state.games_played = 0
                    st.session_state.correct = 0
                    st.session_state.restart_button = False

if __name__ == "__main__":
    st.title("Finance Game")
    
    # Initializing or resetting session state variables
    if 'games_played' not in st.session_state:
        st.session_state.games_played = 0
    if 'correct' not in st.session_state:
        st.session_state.correct = 0
    if 'num_games' not in st.session_state or 'restart_button' in st.session_state and st.session_state.restart_button:
        st.session_state.num_games = st.number_input("How many times do you want to play?", min_value=1, max_value=100, value=1, step=1)
    
    play_game()
