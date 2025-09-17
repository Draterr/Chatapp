const login = document.getElementById("login");
const register = document.getElementById("register");
const login_text = document.getElementById("login-text");
const sign_inButton = document.getElementById("login-button");

login.addEventListener("submit",async function(e){
	e.preventDefault();
	login.reset();
	const form_data = new FormData(login);
	const data = Object.fromEntries(form_data);
	const json_value = JSON.stringify(data);
	let endpoint = "/api/login";
	if(login_text.innerText !== "Sign in"){
		endpoint = "/api/register"	
	}
	const response = await fetch(endpoint,{
		method: "POST",
		headers:{
			"Content-Type":"application/json",
			"Accept": "application/json"
			},
		body: json_value,
	})
	const res_json = await response.json()
	//if the user login successfully we redirect them to main page
	if(res_json.message === "Successfully Loggined!"){
		window.location.href= "/";
	}
	if(res_json.message === "Successfully Registed!"){
		register.click();
	}
})
register.addEventListener("click",()=>{
	if(register.innerText === "Register now"){
		document.getElementById("login-text").innerText = "Register";
		register.innerText = "Login";
		sign_inButton.innerText = "Register";
	}
	else{
		document.getElementById("login-text").innerText = "Sign in";
		register.innerText = "Register now";
		sign_inButton.innerText = "Sign in";
	}
})
